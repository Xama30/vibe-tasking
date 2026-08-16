export interface Project {
  id: number;
  name: string;
  repo_path: string;
  github_repo: string | null;
  default_branch: string;
  default_model: string | null;
  default_effort: string | null;
}

export type TaskStatus = 'backlog' | 'ready' | 'running' | 'review' | 'done';

export interface Task {
  id: number;
  project_id: number;
  type: 'task' | 'bug';
  title: string;
  body: string;
  status: TaskStatus;
  last_run_status?: string | null;
  last_run_id?: number | null;
  pr_url?: string | null;
  run_count?: number;
}

export interface Choice {
  id: string;
  label: string;
  hint: string;
}

export interface ChatMessage {
  id: number;
  project_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface Run {
  id: number;
  task_id: number;
  provider: string;
  model: string | null;
  effort: string | null;
  agent_session_id: string | null;
  branch: string;
  status: string;
  pr_url: string | null;
  error: string | null;
  cost_usd: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface RunEvent {
  id: number;
  kind: string;
  summary: string;
  created_at: string;
}

export interface Message {
  id: number;
  task_id: number;
  run_id: number | null;
  role: string;
  content: string;
  created_at: string;
}

export interface Health {
  maxConcurrentRuns: number;
  providers: { claude: { ok: boolean; detail: string } };
  github: { ok: boolean; detail: string };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>('/api/health'),

  projects: () => request<{ projects: Project[] }>('/api/projects'),

  createProject: (input: {
    name: string;
    repoPath?: string;
    createGithubRepo?: boolean;
    isPrivate?: boolean;
  }) =>
    request<{ project: Project; notes: string[] }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  board: (projectId: number) =>
    request<{ project: Project; columns: TaskStatus[]; tasks: Task[] }>(
      `/api/projects/${projectId}/board`,
    ),

  createTask: (projectId: number, title: string, description: string, type: 'task' | 'bug') =>
    request<{ task: Task }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ projectId, title, description, type }),
    }),

  task: (taskId: number) =>
    request<{ task: Task; runs: Run[]; messages: Message[] }>(`/api/tasks/${taskId}`),

  updateTask: (taskId: number, patch: { status?: TaskStatus; title?: string }) =>
    request<{ task: Task }>(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  choices: () => request<{ models: Choice[]; efforts: Choice[] }>('/api/models'),

  chatHistory: (projectId: number) =>
    request<{ messages: ChatMessage[] }>(`/api/projects/${projectId}/chat`),

  sendChat: (projectId: number, content: string, model?: string) =>
    request<{ reply: string; costUsd: number | null; createdTasks: boolean }>(
      `/api/projects/${projectId}/chat`,
      { method: 'POST', body: JSON.stringify({ content, model }) },
    ),

  resetChat: (projectId: number) =>
    request<{ reset: boolean }>(`/api/projects/${projectId}/chat`, { method: 'DELETE' }),

  setProjectDefaults: (projectId: number, defaultModel: string, defaultEffort: string) =>
    request<{ project: Project }>(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ defaultModel, defaultEffort }),
    }),

  runTask: (taskId: number, model?: string, effort?: string) =>
    request<{ runId: number }>(`/api/tasks/${taskId}/run`, {
      method: 'POST',
      body: JSON.stringify({ model, effort }),
    }),

  comment: (taskId: number, content: string, run: boolean, model?: string, effort?: string) =>
    request<{ queued: boolean; runId?: number }>(`/api/tasks/${taskId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, run, model, effort }),
    }),

  runEvents: (runId: number) => request<{ events: RunEvent[] }>(`/api/runs/${runId}/events`),

  cancelRun: (runId: number) =>
    request<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' }),
};

/** Subscribe to server push. Returns an unsubscribe function. */
export function subscribe(onMessage: (message: Record<string, unknown>) => void): () => void {
  const source = new EventSource('/api/stream');
  source.onmessage = (event) => {
    try {
      onMessage(JSON.parse(event.data) as Record<string, unknown>);
    } catch {
      /* heartbeat or malformed frame — ignore */
    }
  };
  return () => source.close();
}
