# vibe-tasking

A Kanban board where the cards get implemented by coding agents. Local-first:
it runs on your machine, drives your own `claude` CLI, and works on real git
branches in your real repos.

## Why local

Using a Claude subscription means the agent has to run where you're logged in.
Anthropic doesn't permit third-party products to offer claude.ai login, so the
runner drives **your** `claude` CLI as a subprocess rather than embedding the
Agent SDK with someone else's credentials. That constraint turns out to be a
feature: the agent gets real filesystem and git access, and adding a second
provider (Codex, etc.) is just another subprocess behind `AgentProvider`.

If you ever share this with someone else, they'd need their own API key —
the subscription path only works for the machine you're logged in on.

## Which account pays

Runs use your **Claude Code login**, not an API key — the CLI reports
`apiKeySource: none` and authenticates from `~/.claude/.credentials.json`.

The runner passes the parent environment straight through to the CLI, so an
`ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) exported for some other project
would silently move every run onto metered API billing. The header shows which
one is active — `● Subscription` or a `⚠ API key billing` warning — so unset
the variable if you see the warning.

**The dollar figures on runs are estimates, not charges.** The CLI reports what
the tokens would cost at list API rates regardless of how you authenticate. On
a subscription nothing is billed per run; treat the number as a proxy for how
much of your rate limit a run consumed. That's also why `VIBE_MAX_CONCURRENT`
defaults to 2 — rate limits are the real ceiling.

## Requirements

- Node 24+ (uses `node:sqlite` and native TypeScript execution — no build step)
- `claude` CLI, logged in (`claude` → `/login`)
- `git`
- `gh` CLI, authenticated — optional, only needed to open PRs

## Run it

```bash
npm install
npm run dev          # server on :5178, UI on :5179
```

Open http://localhost:5179.

## Creating a project

New projects get a local git repo, a scaffold commit, and a **private** GitHub
repo, then the board is ready to open PRs against it:

```
name ─▶ git init ─▶ scaffold + first commit ─▶ gh repo create --private --push
```

Private is the default and the checkbox is opt-out — a board that creates repos
on your behalf shouldn't be able to publish one by accident. Point a project at
an existing repo instead by passing `repoPath`, and nothing is created.

Edit `server/src/scaffold.ts` to change what lands in a new repo. It's the only
place scaffolding lives, so per-language templates are a matter of returning a
different array.

## Streams — what can run in parallel

Every task carries a **stream** number:

- **Same stream** → runs in order. A task is blocked until every earlier task in
  its stream is `done`.
- **Different streams** → safe to run at the same time.

```
stream 1:  #16 delete command → #17 --json on list → #18 --json on delete
stream 2:  #19 CONTRIBUTING.md                    (parallel — different file)
```

This exists because each task is implemented in its own worktree branched from
the default branch. Two tasks editing the same file produce conflicting PRs, and
a task can't see work that hasn't merged yet. Streams are how you say "these
collide, do them in order".

Blocked tasks are dimmed on the board and their **Implement** button is
disabled, with the blockers listed. **Run anyway** overrides it when you know
better. **Run N unblocked** in the header starts the head of every stream at
once — the payoff for splitting well — still capped by `VIBE_MAX_CONCURRENT`.

The planner assigns streams; `server/src/prompts/planning.md` is the guidance it
follows, including how to decide the split. Edit that file to change how work
gets divided.

> Tasks created before streams existed all sit at stream 1, order 0, so they
> don't block each other. Reorder them from the chat ("put #6 after #5") if you
> want the dependency enforced.

## The planning chat

"Plan" opens a conversation that files tasks for you. It reads the repo to
ground its descriptions, then calls board tools to create them:

```
you ──▶ claude -p --mcp-config {board} --permission-mode dontAsk
             │  tools: Read, Glob, Grep + create_tasks/list_tasks/update_task
             ▼
        tasks appear in Backlog
```

The board tools are a small stdio **MCP server** (`server/src/mcp/board.ts`)
spawned per turn. It talks to SQLite directly rather than back through the HTTP
API — no auth story, no port assumptions — and takes its project id from the
env block in `--mcp-config`, so a chat can only touch its own board.

**The planner is read-only over your code.** `Read`, `Glob`, and `Grep` are
allowed; `Write`, `Edit`, and `Bash` are not, and `--permission-mode dontAsk`
denies anything not explicitly listed. Implementation happens in a task run,
under review, not in the chat. `--strict-mcp-config` also keeps your global MCP
servers out of this session.

The conversation resumes across turns and survives restarts (the session id is
stored on the project), so you can come back tomorrow and say "split #5".

Pick the planner's model from the dropdown in its header. It defaults to Sonnet
rather than the project's implementation model: planning happens far more often
than implementation, and a human reviews the board before anything runs.

The decomposition guidance lives in `server/src/prompts/planning.md`. It is
appended to the system prompt every turn rather than registered as a Claude Code
skill — skills load on demand when their description matches, and splitting work
is this agent's entire job, so it must never be the turn where the guidance
didn't trigger. Edit the file like you would a skill; it applies immediately.

## Choosing a model

Each run picks a model and an effort level, falling back to the project default
and then to your Claude Code settings. Aliases are used rather than pinned ids
so a new model generation is picked up without a code change:

| Alias | Resolves to | Good for |
| --- | --- | --- |
| `opus` | `claude-opus-5` | Hard, multi-file work |
| `sonnet` | `claude-sonnet-5` | Near-Opus coding, cheaper |
| `haiku` | `claude-haiku-4-5` | Small, well-specified edits |

Effort (`low` → `max`) is often the bigger lever: it controls how much the agent
explores and verifies before answering. `xhigh` suits agentic coding; the lower
levels are stronger than their names suggest.

The spread is real — the same board produced a $0.48 Opus run and a $0.04
Haiku/low run. Run history records the **resolved** model id rather than the
alias, because `opus` today and `opus` in six months are different models.

Edit `server/src/models.ts` to change the offered choices. `fable` is omitted
because it only resolves on plans that include it.

## How it works

```
Task card ──▶ git worktree on task/<id>-<slug>
                   │
                   ▼
          claude -p --output-format stream-json
                   │  (events persisted + streamed to the UI over SSE)
                   ▼
          commit ─▶ push ─▶ gh pr create ─▶ Review column
```

**Isolation.** Every run gets its own git worktree and branch, so concurrent
tasks can't corrupt each other's working tree. The agent's `cwd` is the
worktree; `--permission-mode acceptEdits` plus an allow/deny tool list keeps it
from wandering. Worktrees live in `<workspace>/.vibe-worktrees/<project>/` and
are disposable — the DB is the source of truth.

**Iteration.** Each run stores the agent's session id. Commenting on a task
resumes that session on the same branch, so follow-up commits stack onto the
existing PR instead of opening a new one. "Note only" records feedback without
starting a run.

**Persistence.** Everything lives in `~/.vibe-tasking/db.sqlite`, outside any
repo. Restarting the server (or your machine) leaves the board intact; runs
that were in flight during a crash are reconciled to `failed` on boot so the
board never shows a ghost agent.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `VIBE_PORT` | `5178` | API port |
| `VIBE_DATA_DIR` | `~/.vibe-tasking` | SQLite location |
| `VIBE_WORKSPACE_DIR` | `~/vibe-tasking-workspace` | Where new project repos are created |
| `VIBE_MAX_CONCURRENT` | `2` | Simultaneous agent runs |

Keep `VIBE_MAX_CONCURRENT` low. Subscription rate limits, not your CPU, are the
real ceiling — going wide gets you throttled, not faster.

## Layout

```
server/src/
  config.ts            paths + limits
  db.ts                schema, orphaned-run reconciliation
  git.ts               worktrees, commits, push, gh repo/pr create
  chat.ts              the planning chat
  mcp/board.ts         MCP server exposing the board to the chat
  scaffold.ts          what goes into a brand-new project repo
  bus.ts               in-process pub/sub feeding SSE
  runner.ts            queue + the task→worktree→agent→PR pipeline
  routes.ts            REST + /api/stream
  providers/
    types.ts           AgentProvider — the seam for adding Codex
    claude.ts          drives `claude -p` and parses its NDJSON stream
web/src/
  App.tsx              board
  TaskPanel.tsx        task thread, run history, live agent log
  api.ts               typed client + SSE subscription
```

## Not built yet

- Drag-and-drop between columns (status changes go through the API today)
- Streaming for the planning chat (a turn takes ~30s and only shows a spinner)
- In-app diff review (currently links out to the PR)
- Parent/sub-tasks (`tasks.parent_id` exists and is unused)
- Docker-per-run isolation
