import os from 'node:os';
import path from 'node:path';

/**
 * Everything lives outside the repo so the board survives restarts, machine
 * reboots, and `git clean`. The DB is the source of truth; worktrees are
 * disposable and can be recreated from `runs.branch`.
 */
export const HOME = os.homedir();

export const DATA_DIR = process.env.VIBE_DATA_DIR ?? path.join(HOME, '.vibe-tasking');
export const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

/** Where cloned/created project repos live. */
export const WORKSPACE_DIR =
  process.env.VIBE_WORKSPACE_DIR ?? path.join(HOME, 'vibe-tasking-workspace');

export const PORT = Number(process.env.VIBE_PORT ?? 5178);

/**
 * How many agents may run at once. Subscription rate limits, not CPU, are the
 * real ceiling here — going wide gets you throttled, not faster.
 */
export const MAX_CONCURRENT_RUNS = Number(process.env.VIBE_MAX_CONCURRENT ?? 2);
