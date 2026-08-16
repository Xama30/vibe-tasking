import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ChatMessage, type Choice } from './api';

const SUGGESTIONS = [
  'What should I work on next?',
  'Break the next feature into tasks',
  'Review the board — anything missing or duplicated?',
];

export function ChatPanel({
  projectId,
  onClose,
  onBoardChanged,
}: {
  projectId: number;
  onClose: () => void;
  onBoardChanged: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Choice[]>([]);
  // Planning is frequent and cheap next to implementation, so it defaults to
  // Sonnet rather than inheriting the project's implementation model.
  const [model, setModel] = useState('sonnet');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.choices().then((data) => setModels(data.models.filter((choice) => choice.id)));
  }, []);

  const load = useCallback(async () => {
    const data = await api.chatHistory(projectId);
    setMessages(data.messages);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pending]);

  async function send(content: string) {
    if (!content.trim() || pending) return;
    setDraft('');
    setError(null);
    setPending(true);

    // Optimistic echo: turns take 30s+, so the message must appear instantly.
    setMessages((current) => [
      ...current,
      {
        id: -Date.now(),
        project_id: projectId,
        role: 'user',
        content,
        created_at: new Date().toISOString(),
      },
    ]);

    try {
      const result = await api.sendChat(projectId, content, model);
      await load();
      if (result.createdTasks) onBoardChanged();
    } catch (err) {
      setError((err as Error).message);
      await load();
    } finally {
      setPending(false);
    }
  }

  return (
    <aside className="flex h-full w-[420px] max-w-[40vw] min-w-[320px] shrink-0 flex-col border-r border-edge bg-panel">
      <header className="flex items-center gap-2 border-b border-edge px-4 py-3">
        <h2 className="text-sm font-semibold">Plan</h2>
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
          title={models.find((choice) => choice.id === model)?.hint}
          className="rounded border border-edge bg-surface px-1.5 py-0.5 text-xs text-muted"
        >
          {models.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Clear this conversation? Tasks already created are kept.')) {
              void api.resetChat(projectId).then(load);
            }
          }}
          className="ml-auto rounded p-1 text-xs text-muted hover:bg-edge hover:text-ink"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted hover:bg-edge hover:text-ink"
          aria-label="Close chat"
        >
          ✕
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && !pending && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Describe what you want built. I&apos;ll read the repo and file tasks on the board.
            </p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  className="rounded-lg border border-edge px-2.5 py-1.5 text-left text-xs text-muted hover:border-accent hover:text-ink"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === 'user'
                ? 'ml-6 rounded-lg border border-accent/30 bg-accent/5 p-2.5 text-sm whitespace-pre-wrap'
                : 'mr-2 text-sm whitespace-pre-wrap text-ink/90'
            }
          >
            {message.content}
          </div>
        ))}

        {pending && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Reading the repo and planning…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div ref={endRef} />
      </div>

      <footer className="border-t border-edge p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send(draft);
            }
          }}
          placeholder="Describe the work…  (⌘/Ctrl + Enter to send)"
          rows={3}
          disabled={pending}
          className="w-full resize-none rounded-lg border border-edge bg-surface p-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          type="button"
          disabled={pending || !draft.trim()}
          onClick={() => void send(draft)}
          className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40"
        >
          {pending ? 'Planning…' : 'Send'}
        </button>
      </footer>
    </aside>
  );
}
