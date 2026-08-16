import { spawn } from 'node:child_process';
import { sh } from '../git.ts';
import type { AgentEvent, AgentProvider, AgentRunOptions, AgentRunResult } from './types.ts';

/**
 * Tools the agent may use without prompting.
 *
 * `Bash` is the sharp edge: it's required for git, tests, and package managers,
 * but it's also arbitrary code execution. The confinement story is the worktree
 * (`cwd`) plus DENIED_TOOLS below. Docker-per-run is the next step up if this
 * ever runs against code you don't trust.
 */
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', 'Bash'];

/** Blunt guardrails against the commands that ruin your afternoon. */
const DENIED_TOOLS = [
  'Bash(rm -rf /*)',
  'Bash(sudo *)',
  'Bash(shutdown *)',
  'Bash(reboot *)',
  'Bash(mkfs *)',
  'Bash(git push --force *)',
  'Bash(git reset --hard *)',
];

interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  model?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
  attempt?: number;
  max_retries?: number;
  error?: string;
  retry_delay_ms?: number;
}

function preview(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Turn one NDJSON line into zero or more UI-facing events. */
function toEvents(line: StreamLine): AgentEvent[] {
  const events: AgentEvent[] = [];

  if (line.type === 'system' && line.subtype === 'init') {
    events.push({
      kind: 'init',
      summary: `Session started (${line.model ?? 'default model'})`,
      data: line,
    });
    return events;
  }

  if (line.type === 'system' && line.subtype === 'api_retry') {
    events.push({
      kind: 'retry',
      summary: `API retry ${line.attempt}/${line.max_retries} — ${line.error} (waiting ${line.retry_delay_ms}ms)`,
      data: line,
    });
    return events;
  }

  if (line.type === 'assistant') {
    for (const block of line.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        events.push({ kind: 'text', summary: block.text, data: block });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        events.push({ kind: 'thinking', summary: preview(block.thinking, 200), data: block });
      } else if (block.type === 'tool_use') {
        events.push({
          kind: 'tool_use',
          summary: `${block.name}: ${preview(block.input)}`,
          data: block,
        });
      }
    }
    return events;
  }

  if (line.type === 'user') {
    for (const block of line.message?.content ?? []) {
      if (block.type === 'tool_result') {
        events.push({
          kind: 'tool_result',
          summary: `${block.is_error ? '✗' : '✓'} ${preview(block.content, 200)}`,
          data: block,
        });
      }
    }
    return events;
  }

  if (line.type === 'result') {
    events.push({
      kind: 'result',
      summary: line.is_error
        ? `Run failed: ${preview(line.result)}`
        : `Run finished${line.total_cost_usd ? ` ($${line.total_cost_usd.toFixed(4)})` : ''}`,
      data: line,
    });
  }

  return events;
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly label = 'Claude Code';

  async available(): Promise<{ ok: boolean; detail: string }> {
    const res = await sh('claude', ['--version']);
    return res.code === 0
      ? { ok: true, detail: res.stdout }
      : { ok: false, detail: 'claude CLI not found on PATH' };
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const { prompt, cwd, model, effort, resumeSessionId, signal, onEvent } = options;

    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      // Lets the agent write files and run common fs commands unattended.
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ALLOWED_TOOLS.join(','),
      '--disallowedTools',
      DENIED_TOOLS.join(','),
    ];

    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    // Resuming is what makes task iteration cheap: the agent keeps everything
    // it already learned about this task instead of re-reading the repo.
    if (resumeSessionId) args.push('--resume', resumeSessionId);

    // NOTE: deliberately no `--bare`. Bare mode never reads OAuth credentials
    // and requires ANTHROPIC_API_KEY, which would bypass the subscription.
    const child = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let sessionId: string | null = resumeSessionId ?? null;
    let resolvedModel: string | null = null;
    let finalText = '';
    let costUsd: number | null = null;
    let failed: string | undefined;
    let buffer = '';

    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });

    const handleLine = (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;

      let parsed: StreamLine;
      try {
        parsed = JSON.parse(trimmed) as StreamLine;
      } catch {
        // Non-JSON on stdout is unexpected but not fatal; surface it verbatim.
        onEvent({ kind: 'stderr', summary: trimmed });
        return;
      }

      if (parsed.session_id) sessionId = parsed.session_id;
      if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.model) {
        resolvedModel = parsed.model;
      }
      if (parsed.type === 'result') {
        finalText = parsed.result ?? '';
        costUsd = parsed.total_cost_usd ?? null;
        if (parsed.is_error) failed = parsed.result ?? 'agent reported an error';
      }

      for (const event of toEvents(parsed)) onEvent(event);
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
      const text = chunk.trim();
      if (text) onEvent({ kind: 'stderr', summary: text });
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    }).finally(() => signal.removeEventListener('abort', onAbort));

    if (buffer.trim()) handleLine(buffer);

    if (signal.aborted) {
      return { ok: false, sessionId, resolvedModel, text: finalText, costUsd, error: 'Cancelled' };
    }
    if (exitCode !== 0 && !failed) {
      failed = `claude exited with code ${exitCode}`;
    }

    return { ok: !failed, sessionId, resolvedModel, text: finalText, costUsd, error: failed };
  }
}
