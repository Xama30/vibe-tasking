import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_PATH } from './config.ts';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  repo_path      TEXT NOT NULL,
  github_repo    TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task','bug')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'backlog'
             CHECK (status IN ('backlog','ready','running','review','done')),
  parent_id  INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL DEFAULT 'claude',
  model            TEXT,
  agent_session_id TEXT,
  branch           TEXT NOT NULL,
  worktree_path    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  pr_url           TEXT,
  error            TEXT,
  cost_usd         REAL,
  started_at       TEXT,
  ended_at         TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id     INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status, position);
CREATE INDEX IF NOT EXISTS idx_runs_task     ON runs(task_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_run    ON events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, id);
`);

/**
 * A run marked `running` in the DB while no process exists is a crashed run —
 * the server died mid-flight. Reconcile on boot so the board never shows a
 * ghost agent that will never finish.
 */
export function reconcileOrphanedRuns(): number {
  const { changes } = db
    .prepare(
      `UPDATE runs SET status = 'failed',
                       error = 'Server restarted while this run was in flight',
                       ended_at = ?
       WHERE status IN ('running','queued')`,
    )
    .run(new Date().toISOString());

  if (changes > 0) {
    db.exec(`UPDATE tasks SET status = 'ready' WHERE status = 'running'`);
  }
  return Number(changes);
}

export const now = () => new Date().toISOString();
