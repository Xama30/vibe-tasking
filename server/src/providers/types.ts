/**
 * One interface, many CLIs. Claude Code and Codex are both just subprocesses
 * that stream structured events; keeping the surface this small is what makes
 * adding a second provider a day of work instead of a rewrite.
 */

export type AgentEventKind =
  | 'init'
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'retry'
  | 'result'
  | 'error'
  | 'stderr';

export interface AgentEvent {
  kind: AgentEventKind;
  /** Short human-readable line for the activity feed. */
  summary: string;
  /** Full structured payload, persisted for replay. */
  data?: unknown;
}

export interface AgentRunOptions {
  prompt: string;
  /** The worktree. The agent is confined here. */
  cwd: string;
  model?: string | null;
  /** How hard the agent should work: low | medium | high | xhigh | max. */
  effort?: string | null;
  /** Provider-native session id, to continue a previous run on this task. */
  resumeSessionId?: string | null;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  ok: boolean;
  /** Persist this — it's what makes "iterate on the task" possible later. */
  sessionId: string | null;
  /**
   * What the provider actually ran, as reported by the agent itself. An alias
   * like `opus` says nothing about which Opus you got, so run history records
   * the resolved id rather than the request.
   */
  resolvedModel: string | null;
  text: string;
  costUsd: number | null;
  error?: string;
}

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  /** Whether the underlying CLI is installed and usable. */
  available(): Promise<{ ok: boolean; detail: string }>;
  run(options: AgentRunOptions): Promise<AgentRunResult>;
}
