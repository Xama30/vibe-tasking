import { useCallback, useEffect, useState } from 'react';
import { api, subscribe, type Health, type Project, type Task, type TaskStatus } from './api';
import { TaskPanel } from './TaskPanel';

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'ready', label: 'Ready' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-lg border border-edge bg-panel p-3 text-left transition hover:border-accent/60"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted">
        <span className={task.type === 'bug' ? 'text-rose-400' : 'text-muted'}>
          {task.type === 'bug' ? '🐞 bug' : 'task'}
        </span>
        <span>#{task.id}</span>
        {task.status === 'running' && (
          <span className="ml-auto flex items-center gap-1 text-amber-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            running
          </span>
        )}
        {task.pr_url && task.status !== 'running' && (
          <span className="ml-auto text-accent">PR</span>
        )}
      </div>
      <div className="text-sm leading-snug">{task.title}</div>
      {(task.run_count ?? 0) > 0 && (
        <div className="mt-1.5 text-[11px] text-muted">
          {task.run_count} run{task.run_count === 1 ? '' : 's'}
        </div>
      )}
    </button>
  );
}

function NewTaskForm({ projectId, onCreated }: { projectId: number; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'task' | 'bug'>('task');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-dashed border-edge p-2 text-sm text-muted hover:border-accent hover:text-ink"
      >
        + New task
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        void api.createTask(projectId, title, description, type).then(() => {
          setTitle('');
          setDescription('');
          setOpen(false);
          onCreated();
        });
      }}
      className="space-y-2 rounded-lg border border-edge bg-panel p-3"
    >
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        className="w-full rounded border border-edge bg-surface p-2 text-sm outline-none focus:border-accent"
      />
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="What should the agent do?"
        rows={3}
        className="w-full resize-none rounded border border-edge bg-surface p-2 text-sm outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(event) => setType(event.target.value as 'task' | 'bug')}
          className="rounded border border-edge bg-surface p-1.5 text-sm"
        >
          <option value="task">Task</option>
          <option value="bug">Bug</option>
        </select>
        <button
          type="submit"
          className="ml-auto rounded bg-accent px-3 py-1.5 text-sm font-medium text-surface"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-edge px-3 py-1.5 text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState('');
  const [createRepo, setCreateRepo] = useState(true);
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          setError(null);
          api
            .createProject({ name: name.trim(), createGithubRepo: createRepo, isPrivate })
            .then((data) => onCreated(data.project))
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
        className="w-[420px] space-y-4 rounded-xl border border-edge bg-panel p-5"
      >
        <h2 className="text-base font-semibold">New project</h2>

        <div className="space-y-1.5">
          <label htmlFor="project-name" className="text-xs text-muted">
            Name
          </label>
          <input
            id="project-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="my-app"
            className="w-full rounded-lg border border-edge bg-surface p-2 text-sm outline-none focus:border-accent"
          />
        </div>

        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={createRepo}
            onChange={(event) => setCreateRepo(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Create a GitHub repo
            <span className="block text-xs text-muted">
              Initialises the repo locally, pushes it, and enables pull requests.
            </span>
          </span>
        </label>

        {createRepo && (
          <label className="ml-6 flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(event) => setIsPrivate(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Private
              <span className="block text-xs text-muted">Recommended.</span>
            </span>
          </label>
        )}

        {error && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-edge"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [openTaskId, setOpenTaskId] = useState<number | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const currentProject = projects.find((project) => project.id === projectId);

  const refreshBoard = useCallback(async () => {
    if (projectId == null) return;
    const data = await api.board(projectId);
    setTasks(data.tasks);
  }, [projectId]);

  useEffect(() => {
    void api.health().then(setHealth);
    void api.projects().then((data) => {
      setProjects(data.projects);
      if (data.projects.length > 0) setProjectId(data.projects[0].id);
    });
  }, []);

  useEffect(() => {
    void refreshBoard();
  }, [refreshBoard]);

  // Server push keeps the board honest while agents work in the background.
  useEffect(() => subscribe(() => void refreshBoard()), [refreshBoard]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge px-4 py-2.5">
        <span className="font-semibold tracking-tight">vibe-tasking</span>

        <select
          value={projectId ?? ''}
          onChange={(event) => setProjectId(Number(event.target.value))}
          className="rounded border border-edge bg-panel px-2 py-1 text-sm"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setNewProjectOpen(true)}
          className="rounded border border-edge px-2 py-1 text-sm text-muted hover:text-ink"
        >
          + Project
        </button>

        {currentProject?.github_repo && (
          <a
            href={`https://github.com/${currentProject.github_repo}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted hover:text-accent"
          >
            {currentProject.github_repo} ↗
          </a>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs text-muted">
          <span title={health?.providers.claude.detail}>
            {health?.providers.claude.ok ? '● Claude ready' : '○ Claude unavailable'}
          </span>
          <span title={health?.github.detail}>
            {health?.github.ok ? '● GitHub' : '○ GitHub'}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 gap-3 overflow-x-auto p-3">
          {projectId == null ? (
            <div className="m-auto text-sm text-muted">Create a project to get started.</div>
          ) : (
            COLUMNS.map((column) => {
              const columnTasks = tasks.filter((task) => task.status === column.id);
              return (
                <section key={column.id} className="flex w-72 shrink-0 flex-col gap-2">
                  <div className="flex items-center gap-2 px-1 text-xs font-medium tracking-wide text-muted uppercase">
                    {column.label}
                    <span className="text-muted/60">{columnTasks.length}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {columnTasks.map((task) => (
                      <TaskCard key={task.id} task={task} onOpen={() => setOpenTaskId(task.id)} />
                    ))}
                    {column.id === 'backlog' && (
                      <NewTaskForm projectId={projectId} onCreated={() => void refreshBoard()} />
                    )}
                  </div>
                </section>
              );
            })
          )}
        </main>

        {openTaskId != null && (
          <TaskPanel
            key={openTaskId}
            taskId={openTaskId}
            onClose={() => setOpenTaskId(null)}
            onChanged={() => void refreshBoard()}
          />
        )}
      </div>

      {newProjectOpen && (
        <NewProjectDialog
          onClose={() => setNewProjectOpen(false)}
          onCreated={(project) => {
            setProjects((current) => [...current, project]);
            setProjectId(project.id);
            setNewProjectOpen(false);
          }}
        />
      )}
    </div>
  );
}
