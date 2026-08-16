import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type Blocker,
  type Choice,
  type Message,
  type Run,
  type RunEvent,
  type Task,
} from './api';

const KIND_STYLE: Record<string, string> = {
  init: 'text-muted',
  text: 'text-ink',
  thinking: 'text-muted italic',
  tool_use: 'text-accent',
  tool_result: 'text-emerald-400',
  result: 'text-emerald-300 font-medium',
  retry: 'text-amber-400',
  error: 'text-rose-400',
  stderr: 'text-rose-400/70',
};

function RunLog({ runId, live }: { runId: number; live: boolean }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void api.runEvents(runId).then((data) => {
      if (!cancelled) setEvents(data.events);
    });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // While a run is live, poll for new events. SSE already pushes them to the
  // board; this keeps the open log in sync without threading state through.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void api.runEvents(runId).then((data) => setEvents(data.events));
    }, 1200);
    return () => clearInterval(timer);
  }, [runId, live]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  return (
    <div className="max-h-72 overflow-y-auto rounded-lg border border-edge bg-surface p-3 font-mono text-xs leading-relaxed">
      {events.length === 0 && <div className="text-muted">Waiting for agent output…</div>}
      {events.map((event) => (
        <div key={event.id} className={`whitespace-pre-wrap ${KIND_STYLE[event.kind] ?? ''}`}>
          <span className="mr-2 text-muted/60">{event.kind}</span>
          {event.summary}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function ChoiceSelect({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
}) {
  const hint = choices.find((choice) => choice.id === value)?.hint;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] tracking-wide text-muted uppercase">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        title={hint}
        className="rounded-lg border border-edge bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TaskPanel({
  taskId,
  onClose,
  onChanged,
}: {
  taskId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Choice[]>([]);
  const [efforts, setEfforts] = useState<Choice[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');

  useEffect(() => {
    void api.choices().then((data) => {
      setModels(data.models);
      setEfforts(data.efforts);
    });
  }, []);

  const load = useCallback(async () => {
    const data = await api.task(taskId);
    setTask(data.task);
    setBlockers(data.blockers);
    setRuns(data.runs);
    setMessages(data.messages);
  }, [taskId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [load]);

  const latestRun = runs[0];
  const isRunning = latestRun?.status === 'running' || latestRun?.status === 'queued';

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!task) return null;

  return (
    <aside className="flex h-full w-[560px] max-w-[50vw] min-w-[380px] shrink-0 flex-col border-l border-edge bg-panel">
      <header className="flex items-start gap-3 border-b border-edge p-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted">
            <span className="rounded border border-edge px-1.5 py-0.5 uppercase tracking-wide">
              {task.type}
            </span>
            <span>#{task.id}</span>
          </div>
          <h2 className="text-lg leading-snug font-semibold">{task.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-edge hover:text-ink"
          aria-label="Close panel"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {task.body && (
          <p className="text-sm whitespace-pre-wrap text-muted">{task.body}</p>
        )}

        {error && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <ChoiceSelect label="Model" value={model} choices={models} onChange={setModel} />
          <ChoiceSelect label="Effort" value={effort} choices={efforts} onChange={setEffort} />
        </div>

        {blockers.length > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5 text-sm">
            <div className="mb-1 text-xs font-medium text-amber-400">
              Waiting on earlier work in stream {task.stream}
            </div>
            <ul className="space-y-0.5 text-xs text-muted">
              {blockers.map((blocker) => (
                <li key={blocker.id}>
                  #{blocker.id} {blocker.title}{' '}
                  <span className="text-muted/60">({blocker.status})</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted">
              This task branches from the default branch, so it can&apos;t see that work until
              it merges.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || isRunning || blockers.length > 0}
            onClick={() => void act(() => api.runTask(task.id, model, effort))}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40"
          >
            {runs.length === 0 ? 'Implement' : 'Run again'}
          </button>
          {blockers.length > 0 && !isRunning && (
            <button
              type="button"
              disabled={busy}
              title="Run despite the unfinished work above"
              onClick={() => void act(() => api.runTask(task.id, model, effort, true))}
              className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-sm text-amber-300 hover:bg-amber-500/10"
            >
              Run anyway
            </button>
          )}
          {isRunning && latestRun && (
            <button
              type="button"
              onClick={() => void act(() => api.cancelRun(latestRun.id))}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-edge"
            >
              Cancel
            </button>
          )}
          {task.status === 'review' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => api.updateTask(task.id, { status: 'done' }))}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-edge"
            >
              Mark done
            </button>
          )}
        </div>

        {runs.map((run, index) => (
          <section key={run.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="font-medium text-ink">Run {runs.length - index}</span>
              <span
                className={
                  run.status === 'succeeded'
                    ? 'text-emerald-400'
                    : run.status === 'failed'
                      ? 'text-rose-400'
                      : 'text-amber-400'
                }
              >
                {run.status}
              </span>
              <code className="rounded bg-surface px-1.5 py-0.5">{run.branch}</code>
              {run.model && <span title="Model that actually ran">{run.model}</span>}
              {run.effort && <span>effort: {run.effort}</span>}
              {run.cost_usd != null && <span>${run.cost_usd.toFixed(3)}</span>}
              {run.pr_url && (
                <a
                  href={run.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  View PR
                </a>
              )}
            </div>
            {run.error && <div className="text-xs text-rose-400">{run.error}</div>}
            {index === 0 && (
              <RunLog runId={run.id} live={run.status === 'running' || run.status === 'queued'} />
            )}
          </section>
        ))}

        {messages.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Thread</h3>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`rounded-lg border p-2 text-sm whitespace-pre-wrap ${
                  message.role === 'user'
                    ? 'border-accent/30 bg-accent/5'
                    : 'border-edge bg-surface text-muted'
                }`}
              >
                <div className="mb-1 text-xs text-muted">{message.role}</div>
                {message.content}
              </div>
            ))}
          </section>
        )}
      </div>

      <footer className="border-t border-edge p-3">
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Ask for a change — the agent resumes on the same branch…"
          rows={3}
          className="w-full resize-none rounded-lg border border-edge bg-surface p-2 text-sm outline-none focus:border-accent"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy || !comment.trim()}
            onClick={() =>
              void act(async () => {
                await api.comment(task.id, comment, false);
                setComment('');
              })
            }
            className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:bg-edge disabled:opacity-40"
          >
            Note only
          </button>
          <button
            type="button"
            disabled={busy || isRunning || !comment.trim()}
            onClick={() =>
              void act(async () => {
                await api.comment(task.id, comment, true, model, effort);
                setComment('');
              })
            }
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40"
          >
            Send &amp; iterate
          </button>
        </div>
      </footer>
    </aside>
  );
}
