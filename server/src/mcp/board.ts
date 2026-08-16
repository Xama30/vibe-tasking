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
  stream: z
    .number()
    .int()
    .min(1)
    .max(99)
    .default(1)
    .describe(
      'Ordering lane. Tasks sharing a stream run strictly in the order listed; different streams run in parallel. Same stream when tasks touch the same files or one depends on another, different streams when they are independent.',
    ),
};

/** Next free slot at the end of a stream, so ordering is stable across calls. */
function nextStreamOrder(stream: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(stream_order), -1) AS max FROM tasks WHERE project_id = ? AND stream = ?',
    )
    .get(PROJECT_ID, stream) as { max: number };
  return row.max + 1;
}

function insertTask(input: {
  title: string;
  description?: string;
  type?: string;
  stream?: number;
  streamOrder: number;
}) {
  const info = db
    .prepare(
      `INSERT INTO tasks (project_id, type, title, body, status, position, stream, stream_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?)`,
    )
    .run(
      PROJECT_ID,
      input.type === 'bug' ? 'bug' : 'task',
      input.title,
      input.description ?? '',
      Date.now(),
      input.stream ?? 1,
      input.streamOrder,
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
      'Add one or more tasks to the board. Prefer a single call with several tasks over repeated calls. Each task should be independently implementable by a coding agent in one sitting. Assign streams so independent work can run in parallel.',
    inputSchema: { tasks: z.array(z.object(taskShape)).min(1).max(20) },
  },
  async ({ tasks }) => {
    // Order within a stream follows the order given, appended after anything
    // already there.
    const cursors = new Map<number, number>();
    const created = tasks.map((task) => {
      const stream = task.stream ?? 1;
      const streamOrder = cursors.get(stream) ?? nextStreamOrder(stream);
      cursors.set(stream, streamOrder + 1);
      return {
        id: insertTask({ ...task, streamOrder }),
        title: task.title,
        stream,
      };
    });

    const byStream = [...new Set(created.map((t) => t.stream))].sort((a, b) => a - b);
    const summary = byStream
      .map((stream) => {
        const rows = created.filter((t) => t.stream === stream);
        return `stream ${stream}: ${rows.map((t) => `#${t.id} ${t.title}`).join(' → ')}`;
      })
      .join('\n');

    return text(
      `Created ${created.length} task(s).\n${summary}\n\n` +
        `${byStream.length} stream(s) can run in parallel; tasks within a stream run in order.`,
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
        `SELECT id, type, title, status, stream, stream_order FROM tasks
         WHERE project_id = ? ORDER BY stream, stream_order, id`,
      )
      .all(PROJECT_ID) as Array<{
      id: number;
      type: string;
      title: string;
      status: string;
      stream: number;
      stream_order: number;
    }>;

    if (rows.length === 0) return text('The board is empty.');
    return text(
      rows
        .map((r) => `stream ${r.stream}.${r.stream_order} #${r.id} [${r.status}] (${r.type}) ${r.title}`)
        .join('\n'),
    );
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
      stream: z.number().int().min(1).max(99).optional().describe('Move the task to a stream'),
      stream_order: z.number().int().min(0).optional().describe('Position within its stream'),
    },
  },
  async ({ id, title, description, status, stream, stream_order }) => {
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
    if (stream !== undefined) {
      updates.push('stream = ?');
      values.push(stream);
      if (stream_order === undefined) {
        updates.push('stream_order = ?');
        values.push(nextStreamOrder(stream));
      }
    }
    if (stream_order !== undefined) (updates.push('stream_order = ?'), values.push(stream_order));
    if (updates.length === 0) return text('Nothing to update.');

    updates.push('updated_at = ?');
    values.push(now(), id);
    db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return text(`Updated task #${id}.`);
  },
);

await server.connect(new StdioServerTransport());
