import path from 'node:path';
import { bus } from './bus.ts';
import { MAX_CONCURRENT_RUNS } from './config.ts';
import { db, now, streamBlockers } from './db.ts';
import {
  commitIfDirty,
  createPullRequest,
  createWorktree,
  currentBranch,
  hasRemote,
  pushBranch,
  slugify,
  summarizeChanges,
} from './git.ts';
import { ClaudeProvider } from './providers/claude.ts';
import type { AgentProvider } from './providers/types.ts';

export const providers = new Map<string, AgentProvider>([['claude', new ClaudeProvider()]]);

interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  github_repo: string | null;
  default_branch: string;
  default_model: string | null;
  default_effort: string | null;
}

interface TaskRow {
  id: number;
  project_id: number;
  type: string;
  title: string;
  body: string;
  status: string;
  stream: number;
  stream_order: number;
}

interface RunRow {
  id: number;
  task_id: number;
  provider: string;
  model: string | null;
  effort: string | null;
  agent_session_id: string | null;
  branch: string;
  worktree_path: string;
  status: string;
}

const active = new Map<number, AbortController>();
const queue: number[] = [];

export const isRunActive = (runId: number) => active.has(runId);

export function cancelRun(runId: number): boolean {
  const controller = active.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

function recordEvent(runId: number, kind: string, summary: string, data?: unknown): void {
  const payload = JSON.stringify({ summary, data: data ?? null });
  const info = db
    .prepare('INSERT INTO events (run_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, kind, payload, now());

  bus.publish({
    type: 'run.event',
    runId,
    event: { id: Number(info.lastInsertRowid), kind, summary, created_at: now() },
  });
}

function setTaskStatus(taskId: number, status: string): void {
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), taskId);
  bus.publish({ type: 'task.updated', taskId, status });
}

function setRunStatus(runId: number, fields: Record<string, unknown>): void {
  const keys = Object.keys(fields);
  const assignments = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE runs SET ${assignments} WHERE id = ?`).run(...Object.values(fields), runId);
  bus.publish({ type: 'run.updated', runId, fields });
}

/**
 * Build the agent prompt.
 *
 * First run: the task itself. Later runs: the task plus everything said since,
 * because the resumed session may have been compacted and the follow-up notes
 * are the whole point of iterating.
 */
function buildPrompt(task: TaskRow, isIteration: boolean): string {
  const kind = task.type === 'bug' ? 'bug' : 'task';

  if (!isIteration) {
    return [
      `You are implementing a single ${kind} from a project board. Work only on this ${kind}.`,
      '',
      `# ${task.title}`,
      task.body ? `\n${task.body}` : '',
      '',
      'Requirements:',
      '- You are already on a dedicated branch in an isolated git worktree. Do not switch branches.',
      '- Make the change, then commit it with a clear message. Commit before you finish.',
      '- Do not push and do not open a pull request; that is handled for you.',
      '- If the repo has tests, run the ones relevant to your change.',
      `- Stay in scope: if you find unrelated problems, mention them but do not fix them.`,
    ].join('\n');
  }

  const followUps = db
    .prepare(
      `SELECT role, content FROM messages
       WHERE task_id = ? AND role = 'user'
       ORDER BY id DESC LIMIT 5`,
    )
    .all(task.id) as Array<{ role: string; content: string }>;

  return [
    `You are continuing work on a ${kind} you already started in this worktree.`,
    '',
    `# ${task.title}`,
    task.body ? `\n${task.body}` : '',
    '',
    '## Follow-up feedback (most recent first)',
    ...followUps.map((m) => `- ${m.content}`),
    '',
    'Address the feedback above. Commit your changes. Do not push or open a PR.',
  ].join('\n');
}

/** Queue a run and kick the scheduler. */
export function enqueueRun(opts: {
  taskId: number;
  model?: string | null;
  effort?: string | null;
  provider?: string;
  /** Start even if earlier work in the same stream is unfinished. */
  force?: boolean;
}): { runId: number } {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(opts.taskId) as
    | TaskRow
    | undefined;
  if (!task) throw new Error(`Task ${opts.taskId} not found`);

  // Streams exist to stop agents branching from a main that doesn't yet contain
  // the work they depend on. Overridable, because sometimes you know better.
  if (!opts.force) {
    const blockers = streamBlockers(task.id);
    if (blockers.length > 0) {
      const names = blockers.map((b) => `#${b.id} ${b.title} (${b.status})`).join(', ');
      throw new Error(
        `Blocked by earlier work in stream ${task.stream}: ${names}. Finish it first, or force to run anyway.`,
      );
    }
  }

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) as
    | ProjectRow
    | undefined;
  if (!project) throw new Error(`Project ${task.project_id} not found`);

  // Reuse the branch and session from the last run so iteration stacks commits
  // onto the same PR instead of opening a new one.
  const previous = db
    .prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1`)
    .get(task.id) as RunRow | undefined;

  const branch = previous?.branch ?? `task/${task.id}-${slugify(task.title)}`;
  const worktreeRoot = path.join(path.dirname(project.repo_path), '.vibe-worktrees', project.name);
  const worktreePath = path.join(worktreeRoot, branch.replace(/\//g, '__'));

  // Explicit choice for this run wins, then the project default, then the
  // CLI's own default (null — we simply omit the flag).
  const model = opts.model ?? project.default_model ?? null;
  const effort = opts.effort ?? project.default_effort ?? null;

  const info = db
    .prepare(
      `INSERT INTO runs (task_id, provider, model, effort, agent_session_id, branch, worktree_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`,
    )
    .run(
      task.id,
      opts.provider ?? 'claude',
      model,
      effort,
      previous?.agent_session_id ?? null,
      branch,
      worktreePath,
    );

  const runId = Number(info.lastInsertRowid);
  setTaskStatus(task.id, 'running');
  bus.publish({ type: 'run.created', runId, taskId: task.id });

  queue.push(runId);
  drain();
  return { runId };
}

function drain(): void {
  while (active.size < MAX_CONCURRENT_RUNS && queue.length > 0) {
    const runId = queue.shift()!;
    void execute(runId);
  }
}

async function execute(runId: number): Promise<void> {
  const controller = new AbortController();
  active.set(runId, controller);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(run.task_id) as TaskRow;
  const project = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(task.project_id) as ProjectRow;

  setRunStatus(runId, { status: 'running', started_at: now() });

  try {
    const provider = providers.get(run.provider);
    if (!provider) throw new Error(`Unknown provider: ${run.provider}`);

    const baseBranch = project.default_branch || (await currentBranch(project.repo_path));
    const isIteration = Boolean(run.agent_session_id);

    recordEvent(runId, 'init', `Preparing worktree on branch ${run.branch}`);
    await createWorktree({
      repoPath: project.repo_path,
      worktreeRoot: path.dirname(run.worktree_path),
      branch: run.branch,
      baseBranch,
    });

    const result = await provider.run({
      prompt: buildPrompt(task, isIteration),
      cwd: run.worktree_path,
      model: run.model,
      effort: run.effort,
      resumeSessionId: run.agent_session_id,
      signal: controller.signal,
      onEvent: (event) => recordEvent(runId, event.kind, event.summary, event.data),
    });

    if (result.sessionId) {
      setRunStatus(runId, { agent_session_id: result.sessionId });
    }
    // Record what actually ran, not what was asked for — `opus` today and
    // `opus` in six months are different models.
    if (result.resolvedModel) {
      setRunStatus(runId, { model: result.resolvedModel });
    }
    if (result.costUsd != null) {
      setRunStatus(runId, { cost_usd: result.costUsd });
    }

    if (!result.ok) throw new Error(result.error ?? 'Agent run failed');

    // Safety net: an agent that edited files but forgot to commit shouldn't
    // lose the work when the worktree is later reused.
    if (await commitIfDirty(run.worktree_path, `${task.title} (uncommitted changes)`)) {
      recordEvent(runId, 'tool_use', 'Committed leftover uncommitted changes');
    }

    const changes = await summarizeChanges(run.worktree_path, baseBranch);
    recordEvent(
      runId,
      'result',
      `${changes.commits} commit(s), ${changes.changedFiles} file(s) changed (+${changes.insertions}/-${changes.deletions})`,
      changes,
    );

    if (changes.commits === 0) {
      recordEvent(runId, 'error', 'Agent produced no commits — nothing to review');
      setRunStatus(runId, { status: 'succeeded', ended_at: now() });
      setTaskStatus(task.id, 'ready');
      return;
    }

    let prUrl: string | null = null;
    if (await hasRemote(project.repo_path)) {
      const pushed = await pushBranch(run.worktree_path, run.branch);
      recordEvent(runId, pushed.ok ? 'result' : 'error', `Push: ${pushed.detail || 'ok'}`);

      if (pushed.ok) {
        const pr = await createPullRequest({
          worktreePath: run.worktree_path,
          branch: run.branch,
          baseBranch,
          title: task.title,
          body: `${task.body}\n\n---\nOpened by vibe-tasking for task #${task.id}.`,
        });
        prUrl = pr.url;
        recordEvent(runId, pr.url ? 'result' : 'error', pr.detail);
      }
    } else {
      recordEvent(runId, 'error', 'No git remote configured — skipped push and PR');
    }

    setRunStatus(runId, { status: 'succeeded', ended_at: now(), pr_url: prUrl });
    setTaskStatus(task.id, 'review');

    db.prepare(
      'INSERT INTO messages (task_id, run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(task.id, runId, 'agent', result.text || '(no summary returned)', now());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordEvent(runId, 'error', message);
    setRunStatus(runId, {
      status: controller.signal.aborted ? 'cancelled' : 'failed',
      error: message,
      ended_at: now(),
    });
    setTaskStatus(run.task_id, 'ready');
  } finally {
    active.delete(runId);
    drain();
  }
}
