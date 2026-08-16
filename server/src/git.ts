import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a command, returning its exit code instead of throwing on non-zero. */
export async function sh(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message).trim(),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

const git = (args: string[], cwd: string) => sh('git', args, cwd);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task';
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  if (!fs.existsSync(repoPath)) return false;
  const { code } = await git(['rev-parse', '--git-dir'], repoPath);
  return code === 0;
}

export async function currentBranch(repoPath: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  return stdout || 'main';
}

export async function hasRemote(repoPath: string): Promise<boolean> {
  const { stdout } = await git(['remote'], repoPath);
  return stdout.length > 0;
}

/**
 * Create an isolated worktree on a fresh branch cut from `baseBranch`.
 *
 * Worktrees are what make concurrent tasks safe: each agent gets its own
 * working directory and branch, so two runs can never fight over the index.
 * Worktrees live outside the repo so they don't pollute status or get committed.
 */
export async function createWorktree(opts: {
  repoPath: string;
  worktreeRoot: string;
  branch: string;
  baseBranch: string;
}): Promise<{ worktreePath: string }> {
  const { repoPath, worktreeRoot, branch, baseBranch } = opts;
  fs.mkdirSync(worktreeRoot, { recursive: true });
  const worktreePath = path.join(worktreeRoot, branch.replace(/\//g, '__'));

  if (fs.existsSync(worktreePath)) {
    await removeWorktree(repoPath, worktreePath);
  }

  // Reuse the branch if a previous run already created it (iteration case).
  const exists = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath);
  const args =
    exists.code === 0
      ? ['worktree', 'add', worktreePath, branch]
      : ['worktree', 'add', '-b', branch, worktreePath, baseBranch];

  const res = await git(args, repoPath);
  if (res.code !== 0) {
    throw new Error(`git worktree add failed: ${res.stderr || res.stdout}`);
  }
  return { worktreePath };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(['worktree', 'remove', '--force', worktreePath], repoPath);
  await git(['worktree', 'prune'], repoPath);
}

export interface WorktreeChanges {
  changedFiles: number;
  insertions: number;
  deletions: number;
  commits: number;
  diffStat: string;
}

/** Summarise what a run actually produced, relative to its base branch. */
export async function summarizeChanges(
  worktreePath: string,
  baseBranch: string,
): Promise<WorktreeChanges> {
  const stat = await git(['diff', '--shortstat', `${baseBranch}...HEAD`], worktreePath);
  const names = await git(['diff', '--stat', `${baseBranch}...HEAD`], worktreePath);
  const log = await git(['rev-list', '--count', `${baseBranch}..HEAD`], worktreePath);

  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
    stat.stdout,
  );

  return {
    changedFiles: m ? Number(m[1]) : 0,
    insertions: m?.[2] ? Number(m[2]) : 0,
    deletions: m?.[3] ? Number(m[3]) : 0,
    commits: Number(log.stdout) || 0,
    diffStat: names.stdout,
  };
}

/**
 * Commit anything the agent left uncommitted. Agents usually commit their own
 * work, but a run that edits files and stops short shouldn't lose them.
 */
export async function commitIfDirty(worktreePath: string, message: string): Promise<boolean> {
  const status = await git(['status', '--porcelain'], worktreePath);
  if (!status.stdout) return false;
  await git(['add', '-A'], worktreePath);
  const res = await git(['commit', '-m', message], worktreePath);
  return res.code === 0;
}

export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = await git(['push', '-u', 'origin', branch], worktreePath);
  return { ok: res.code === 0, detail: res.stderr || res.stdout };
}

/**
 * Create a GitHub repo from an existing local repo and push to it.
 *
 * Private by default — a board that auto-creates repos should never surprise
 * you by publishing one. Failure is non-fatal: the local repo and the project
 * row remain valid, you just don't get a remote.
 */
export async function createGitHubRepo(opts: {
  repoPath: string;
  name: string;
  isPrivate: boolean;
}): Promise<{ slug: string | null; url: string | null; detail: string }> {
  const { repoPath, name, isPrivate } = opts;

  const auth = await sh('gh', ['auth', 'status'], repoPath);
  if (auth.code !== 0) {
    return { slug: null, url: null, detail: 'gh not authenticated — created local repo only' };
  }

  const res = await sh(
    'gh',
    [
      'repo',
      'create',
      name,
      isPrivate ? '--private' : '--public',
      '--source',
      repoPath,
      '--remote',
      'origin',
      '--push',
    ],
    repoPath,
  );

  if (res.code !== 0) {
    return { slug: null, url: null, detail: res.stderr || res.stdout };
  }

  const url = /https:\/\/github\.com\/\S+/.exec(res.stdout + res.stderr)?.[0] ?? null;
  const slug = url ? url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : null;
  return { slug, url, detail: `Created ${isPrivate ? 'private' : 'public'} repo` };
}

/**
 * Open a PR via the `gh` CLI. Degrades gracefully: a missing or expired gh
 * token must not fail the run, since the branch and commits are already safe.
 */
export async function createPullRequest(opts: {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<{ url: string | null; detail: string }> {
  const { worktreePath, branch, baseBranch, title, body } = opts;

  const auth = await sh('gh', ['auth', 'status'], worktreePath);
  if (auth.code !== 0) {
    return { url: null, detail: 'gh not authenticated — run `gh auth login`. Branch was pushed.' };
  }

  const existing = await sh(
    'gh',
    ['pr', 'list', '--head', branch, '--json', 'url', '--jq', '.[0].url'],
    worktreePath,
  );
  if (existing.code === 0 && existing.stdout) {
    return { url: existing.stdout, detail: 'Updated existing PR' };
  }

  const res = await sh(
    'gh',
    ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body', body],
    worktreePath,
  );
  const url = /https:\/\/github\.com\/\S+/.exec(res.stdout)?.[0] ?? null;
  return { url, detail: url ? 'PR created' : res.stderr || res.stdout };
}
