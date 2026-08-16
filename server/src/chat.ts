import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bus } from './bus.ts';
import { db, now } from './db.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(HERE, 'mcp', 'board.ts');

/**
 * The planning chat is deliberately read-only over the codebase: it can look
 * around to write better task descriptions, but only the board tools mutate
 * anything. Implementation happens in a task run, not here.
 */
const CHAT_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'mcp__board__create_tasks',
  'mcp__board__list_tasks',
  'mcp__board__update_task',
];

const SYSTEM_PROMPT = [
  'You are a planning assistant for a task board. The user describes work they want done;',
  'you turn it into board tasks that a coding agent will implement one at a time.',
  '',
  'Guidelines:',
  '- Call list_tasks before creating anything, so you never duplicate existing work.',
  '- Each task must be independently implementable in one sitting, on its own branch.',
  '  If two pieces must land together, they are one task.',
  '- Write the description for the agent who will implement it: what done looks like,',
  '  acceptance criteria, and any files or constraints you found in the repo.',
  '- You may read the codebase to ground your descriptions. You cannot edit it.',
  '- Batch related tasks into a single create_tasks call.',
  '- Do not invent scope. If the request is ambiguous enough that it changes what the',
  '  tasks should be, ask one clarifying question instead of guessing.',
  '- Keep replies short. The board is the deliverable, not your prose.',
].join('\n');

interface ProjectRow {
  id: number;
  repo_path: string;
  chat_session_id: string | null;
  default_model: string | null;
}

export interface ChatReply {
  reply: string;
  sessionId: string | null;
  costUsd: number | null;
  createdTasks: boolean;
}

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  message?: { content?: Array<{ type: string; name?: string }> };
}

export function chatHistory(projectId: number) {
  return db
    .prepare('SELECT * FROM chat_messages WHERE project_id = ? ORDER BY id')
    .all(projectId);
}

export function resetChat(projectId: number): void {
  db.prepare('DELETE FROM chat_messages WHERE project_id = ?').run(projectId);
  db.prepare('UPDATE projects SET chat_session_id = NULL WHERE id = ?').run(projectId);
}

export async function sendChatMessage(opts: {
  projectId: number;
  content: string;
  model?: string | null;
}): Promise<ChatReply> {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(opts.projectId) as
    | ProjectRow
    | undefined;
  if (!project) throw new Error(`Project ${opts.projectId} not found`);

  db.prepare(
    'INSERT INTO chat_messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)',
  ).run(project.id, 'user', opts.content, now());
  bus.publish({ type: 'chat.message', projectId: project.id });

  const mcpConfig = JSON.stringify({
    mcpServers: {
      board: {
        command: process.execPath,
        args: [MCP_SERVER],
        env: { ...process.env, VIBE_PROJECT_ID: String(project.id) },
      },
    },
  });

  const args = [
    '-p',
    opts.content,
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    mcpConfig,
    // Ignore the user's global MCP servers — this chat only needs the board.
    '--strict-mcp-config',
    '--append-system-prompt',
    SYSTEM_PROMPT,
    '--allowedTools',
    CHAT_TOOLS.join(','),
    // Deny anything not explicitly allowed, so the planner can't edit or shell out.
    '--permission-mode',
    'dontAsk',
  ];

  // Sonnet is the default here: planning is frequent and cheap relative to
  // implementation, and the board is reviewed by a human before anything runs.
  args.push('--model', opts.model || project.default_model || 'sonnet');

  if (project.chat_session_id) args.push('--resume', project.chat_session_id);

  const child = spawn('claude', args, {
    cwd: project.repo_path,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let sessionId = project.chat_session_id;
  let reply = '';
  let costUsd: number | null = null;
  let createdTasks = false;
  let failed: string | undefined;
  let buffer = '';
  let stderr = '';

  const handleLine = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let parsed: StreamLine;
    try {
      parsed = JSON.parse(trimmed) as StreamLine;
    } catch {
      return;
    }

    if (parsed.session_id) sessionId = parsed.session_id;

    // Watch for board mutations so the UI can refresh the columns immediately.
    if (parsed.type === 'assistant') {
      for (const block of parsed.message?.content ?? []) {
        if (
          block.type === 'tool_use' &&
          (block.name === 'mcp__board__create_tasks' || block.name === 'mcp__board__update_task')
        ) {
          createdTasks = true;
        }
      }
    }

    if (parsed.type === 'result') {
      reply = parsed.result ?? '';
      costUsd = parsed.total_cost_usd ?? null;
      if (parsed.is_error) failed = parsed.result ?? 'chat failed';
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (buffer.trim()) handleLine(buffer);

  if (exitCode !== 0 && !failed) {
    failed = stderr.trim() || `claude exited with code ${exitCode}`;
  }
  if (failed) throw new Error(failed);

  db.prepare(
    'INSERT INTO chat_messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)',
  ).run(project.id, 'assistant', reply || '(no reply)', now());

  if (sessionId && sessionId !== project.chat_session_id) {
    db.prepare('UPDATE projects SET chat_session_id = ? WHERE id = ?').run(sessionId, project.id);
  }

  bus.publish({ type: 'chat.message', projectId: project.id, createdTasks });

  return { reply, sessionId, costUsd, createdTasks };
}
