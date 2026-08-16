import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { bus } from './bus.ts';
import { chatHistory, resetChat, sendChatMessage } from './chat.ts';
import { MAX_CONCURRENT_RUNS, WORKSPACE_DIR } from './config.ts';
import { db, now } from './db.ts';
import { createGitHubRepo, currentBranch, hasRemote, isGitRepo, sh, slugify } from './git.ts';
import { cancelRun, enqueueRun, providers } from './runner.ts';
import {
  EFFORT_CHOICES,
  MODEL_CHOICES,
  normalizeEffort,
  normalizeModel,
} from './models.ts';
import { defaultScaffold, writeScaffold } from './scaffold.ts';

const BOARD_COLUMNS = ['backlog', 'ready', 'running', 'review', 'done'] as const;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /** Startup diagnostics — surfaces the "gh token expired" class of problem. */
  app.get('/api/health', async () => {
    const claude = await providers.get('claude')!.available();
    const gh = await sh('gh', ['auth', 'status']);

    // The runner passes the parent environment straight through to the CLI, so
    // an ANTHROPIC_API_KEY exported for some other project would silently move
    // every run onto metered API billing. Surface it rather than let it hide.
    const apiKeyVar = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].find(
      (name) => (process.env[name] ?? '') !== '',
    );

    return {
      ok: true,
      maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      workspaceDir: WORKSPACE_DIR,
      auth: apiKeyVar
        ? {
            source: 'api_key' as const,
            detail: `${apiKeyVar} is set — runs are billed to that API account, not your subscription. Unset it to use the subscription.`,
          }
        : {
            source: 'subscription' as const,
            detail: 'Using your Claude Code login. No API key in the environment.',
          },
      providers: { claude },
      github: {
        ok: gh.code === 0,
        detail: gh.code === 0 ? 'authenticated' : 'run `gh auth login` to enable PR creation',
      },
    };
  });

  /** Model and effort options for the pickers. */
  app.get('/api/models', async () => ({
    models: MODEL_CHOICES,
    efforts: EFFORT_CHOICES,
  }));

  app.get('/api/projects', async () => ({
    projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
  }));

  /** Set a project's default model/effort, used when a run doesn't specify. */
  app.patch('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { defaultModel?: string; defaultEffort?: string };

    db.prepare('UPDATE projects SET default_model = ?, default_effort = ? WHERE id = ?').run(
      normalizeModel(body.defaultModel),
      normalizeEffort(body.defaultEffort),
      Number(id),
    );

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { project };
  });

  app.post('/api/projects', async (request, reply) => {
    const body = request.body as {
      name?: string;
      repoPath?: string;
      githubRepo?: string;
      createGithubRepo?: boolean;
      isPrivate?: boolean;
    };
    const name = body.name?.trim();
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const repoPath = body.repoPath?.trim() || path.join(WORKSPACE_DIR, slugify(name));
    const existed = await isGitRepo(repoPath);
    const notes: string[] = [];
    let githubRepo = body.githubRepo ?? null;

    if (!existed) {
      fs.mkdirSync(repoPath, { recursive: true });
      const init = await sh('git', ['init', '-b', 'main'], repoPath);
      if (init.code !== 0) {
        return reply.code(400).send({ error: `git init failed: ${init.stderr}` });
      }

      // A repo with no commits has no branch to cut worktrees from, so the
      // scaffold doubles as the first commit.
      const written = writeScaffold(repoPath, defaultScaffold(name));
      await sh('git', ['add', '-A'], repoPath);
      await sh('git', ['commit', '-m', 'Initial commit'], repoPath);
      notes.push(`Scaffolded ${written.join(', ')}`);
    }

    // Default to creating a private GitHub repo for brand-new projects; never
    // for a repo the user pointed us at, which may already have a remote.
    const shouldCreate = body.createGithubRepo ?? !existed;
    if (shouldCreate && !(await hasRemote(repoPath))) {
      const created = await createGitHubRepo({
        repoPath,
        name: slugify(name),
        isPrivate: body.isPrivate ?? true,
      });
      githubRepo = created.slug ?? githubRepo;
      notes.push(created.detail);
    }

    const info = db
      .prepare(
        `INSERT INTO projects (name, repo_path, github_repo, default_branch, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(name, repoPath, githubRepo, await currentBranch(repoPath), now());

    return {
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid),
      notes,
    };
  });

  /** Planning chat: talk through work, agent files the tasks. */
  app.get('/api/projects/:id/chat', async (request) => {
    const { id } = request.params as { id: string };
    return { messages: chatHistory(Number(id)) };
  });

  app.post('/api/projects/:id/chat', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; model?: string };
    if (!body.content?.trim()) return reply.code(400).send({ error: 'content is required' });

    try {
      return await sendChatMessage({
        projectId: Number(id),
        content: body.content.trim(),
        model: normalizeModel(body.model),
      });
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }
  });

  app.delete('/api/projects/:id/chat', async (request) => {
    const { id } = request.params as { id: string };
    resetChat(Number(id));
    return { reset: true };
  });

  app.get('/api/projects/:id/board', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
    if (!project) return reply.code(404).send({ error: 'project not found' });

    const tasks = db
      .prepare(
        `SELECT t.*,
                (SELECT status FROM runs WHERE task_id = t.id ORDER BY id DESC LIMIT 1) AS last_run_status,
                (SELECT pr_url FROM runs WHERE task_id = t.id ORDER BY id DESC LIMIT 1) AS pr_url,
                (SELECT id      FROM runs WHERE task_id = t.id ORDER BY id DESC LIMIT 1) AS last_run_id,
                (SELECT COUNT(*) FROM runs WHERE task_id = t.id) AS run_count
         FROM tasks t WHERE t.project_id = ?
         ORDER BY t.position, t.id`,
      )
      .all(Number(id));

    return { project, columns: BOARD_COLUMNS, tasks };
  });

  app.post('/api/tasks', async (request, reply) => {
    const body = request.body as {
      projectId?: number;
      title?: string;
      description?: string;
      type?: string;
    };
    if (!body.projectId || !body.title?.trim()) {
      return reply.code(400).send({ error: 'projectId and title are required' });
    }

    const info = db
      .prepare(
        `INSERT INTO tasks (project_id, type, title, body, status, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?)`,
      )
      .run(
        body.projectId,
        body.type === 'bug' ? 'bug' : 'task',
        body.title.trim(),
        body.description ?? '',
        Date.now(),
        now(),
        now(),
      );

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
    bus.publish({ type: 'task.created', task });
    return { task };
  });

  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
    if (!task) return reply.code(404).send({ error: 'task not found' });

    return {
      task,
      runs: db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC').all(Number(id)),
      messages: db
        .prepare('SELECT * FROM messages WHERE task_id = ? ORDER BY id')
        .all(Number(id)),
    };
  });

  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; title?: string; description?: string };

    if (body.status && !BOARD_COLUMNS.includes(body.status as (typeof BOARD_COLUMNS)[number])) {
      return reply.code(400).send({ error: `status must be one of ${BOARD_COLUMNS.join(', ')}` });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.status) (updates.push('status = ?'), values.push(body.status));
    if (body.title) (updates.push('title = ?'), values.push(body.title));
    if (body.description !== undefined) (updates.push('body = ?'), values.push(body.description));
    if (updates.length === 0) return reply.code(400).send({ error: 'nothing to update' });

    updates.push('updated_at = ?');
    values.push(now(), Number(id));
    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
    bus.publish({ type: 'task.updated', taskId: Number(id), task });
    return { task };
  });

  /** Start (or restart) an agent on this task. */
  app.post('/api/tasks/:id/run', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { model?: string; effort?: string; provider?: string };
    try {
      return enqueueRun({
        taskId: Number(id),
        model: normalizeModel(body.model),
        effort: normalizeEffort(body.effort),
        provider: body.provider,
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  /**
   * Iterate: a comment on the task resumes the agent's session on the same
   * branch, so follow-up commits land on the existing PR.
   */
  app.post('/api/tasks/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      content?: string;
      run?: boolean;
      model?: string;
      effort?: string;
    };
    if (!body.content?.trim()) return reply.code(400).send({ error: 'content is required' });

    db.prepare(
      'INSERT INTO messages (task_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    ).run(Number(id), 'user', body.content.trim(), now());
    bus.publish({ type: 'message.created', taskId: Number(id) });

    if (body.run === false) return { queued: false };

    try {
      return {
        queued: true,
        ...enqueueRun({
          taskId: Number(id),
          model: normalizeModel(body.model),
          effort: normalizeEffort(body.effort),
        }),
      };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.get('/api/runs/:id/events', async (request) => {
    const { id } = request.params as { id: string };
    const rows = db
      .prepare('SELECT id, kind, payload, created_at FROM events WHERE run_id = ? ORDER BY id')
      .all(Number(id)) as Array<{ id: number; kind: string; payload: string; created_at: string }>;

    return {
      events: rows.map((row) => {
        const { summary, data } = JSON.parse(row.payload) as { summary: string; data: unknown };
        return { id: row.id, kind: row.kind, summary, data, created_at: row.created_at };
      }),
    };
  });

  app.post('/api/runs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    return { cancelled: cancelRun(Number(id)) };
  });

  /** Server-sent events: board and run activity, pushed as they happen. */
  app.get('/api/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    const unsubscribe = bus.subscribe((message) => {
      reply.raw.write(`data: ${JSON.stringify(message)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 20_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
