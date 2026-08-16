/**
 * MCP server exposing the board to the planning chat.
 *
 * Runs as a short-lived stdio subprocess spawned by the `claude` CLI, so it
 * talks to SQLite directly rather than back through the HTTP API — no auth
 * story, no port assumptions, and WAL mode handles the concurrent access.
 *
 * The project it operates on comes from VIBE_PROJECT_ID, injected via the
 * `--mcp-config` env block, so the chat can never touch another project's board.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { db, now } from '../db.ts';

const PROJECT_ID = Number(process.env.VIBE_PROJECT_ID);
if (!Number.isFinite(PROJECT_ID)) {
  console.error('VIBE_PROJECT_ID must be set');
  process.exit(1);
}

const server = new McpServer({ name: 'vibe-board', version: '0.1.0' });

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

const taskShape = {
  title: z.string().min(1).max(200).describe('Short imperative summary, e.g. "Add password reset"'),
  description: z
    .string()
    .default('')
    .describe(
      'What the agent implementing this should do. Include acceptance criteria and any files or constraints you know about.',
    ),
  type: z.enum(['task', 'bug']).default('task'),
};

function insertTask(input: { title: string; description?: string; type?: string }) {
  const info = db
    .prepare(
      `INSERT INTO tasks (project_id, type, title, body, status, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?)`,
    )
    .run(
      PROJECT_ID,
      input.type === 'bug' ? 'bug' : 'task',
      input.title,
      input.description ?? '',
      Date.now(),
      now(),
      now(),
    );
  return Number(info.lastInsertRowid);
}

server.registerTool(
  'create_tasks',
  {
    title: 'Create board tasks',
    description:
      'Add one or more tasks to the board. Prefer a single call with several tasks over repeated calls. Each task should be independently implementable by a coding agent in one sitting.',
    inputSchema: { tasks: z.array(z.object(taskShape)).min(1).max(20) },
  },
  async ({ tasks }) => {
    const created = tasks.map((task) => ({ id: insertTask(task), title: task.title }));
    return text(
      `Created ${created.length} task(s):\n${created.map((t) => `#${t.id} ${t.title}`).join('\n')}`,
    );
  },
);

server.registerTool(
  'list_tasks',
  {
    title: 'List board tasks',
    description:
      'List tasks already on this board. Call this before creating tasks so you do not duplicate existing work.',
    inputSchema: {},
  },
  async () => {
    const rows = db
      .prepare(
        `SELECT id, type, title, status FROM tasks WHERE project_id = ? ORDER BY position, id`,
      )
      .all(PROJECT_ID) as Array<{ id: number; type: string; title: string; status: string }>;

    if (rows.length === 0) return text('The board is empty.');
    return text(rows.map((r) => `#${r.id} [${r.status}] (${r.type}) ${r.title}`).join('\n'));
  },
);

server.registerTool(
  'update_task',
  {
    title: 'Update a board task',
    description: 'Change the title, description, or status of an existing task.',
    inputSchema: {
      id: z.number().int().positive(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().optional(),
      status: z.enum(['backlog', 'ready', 'running', 'review', 'done']).optional(),
    },
  },
  async ({ id, title, description, status }) => {
    // Scope the write to this project so a hallucinated id can't reach across boards.
    const owned = db
      .prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ?')
      .get(id, PROJECT_ID);
    if (!owned) return text(`Task #${id} is not on this board.`);

    const updates: string[] = [];
    const values: unknown[] = [];
    if (title !== undefined) (updates.push('title = ?'), values.push(title));
    if (description !== undefined) (updates.push('body = ?'), values.push(description));
    if (status !== undefined) (updates.push('status = ?'), values.push(status));
    if (updates.length === 0) return text('Nothing to update.');

    updates.push('updated_at = ?');
    values.push(now(), id);
    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return text(`Updated task #${id}.`);
  },
);

await server.connect(new StdioServerTransport());
