import fs from 'node:fs';
import path from 'node:path';

export interface ScaffoldFile {
  path: string;
  content: string;
}

/**
 * Files written into a brand-new project repo before its first commit.
 *
 * This is deliberately the only place project scaffolding lives, so swapping
 * in per-language templates later means returning a different array — nothing
 * else has to change.
 */
export function defaultScaffold(name: string): ScaffoldFile[] {
  return [
    {
      path: 'README.md',
      content: `# ${name}\n\nCreated by vibe-tasking.\n`,
    },
    {
      path: '.gitignore',
      content: ['node_modules/', 'dist/', 'build/', '.env', '*.log', '.DS_Store', ''].join('\n'),
    },
    {
      path: 'CLAUDE.md',
      content: [
        `# ${name}`,
        '',
        'Notes for agents working in this repo.',
        '',
        '## Conventions',
        '',
        '- Keep changes scoped to the task you were given.',
        '- Add or update tests alongside behavior changes.',
        '',
      ].join('\n'),
    },
  ];
}

/** Write scaffold files, skipping any that already exist. */
export function writeScaffold(repoPath: string, files: ScaffoldFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const target = path.join(repoPath, file.path);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content);
    written.push(file.path);
  }
  return written;
}
