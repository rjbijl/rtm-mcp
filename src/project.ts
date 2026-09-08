import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Walks up from cwd to the nearest directory containing .git. That is a
 * directory for a normal checkout and a file for a worktree; both count.
 * No git subprocess needed.
 */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Lowercase, whitespace to dashes, and no commas: RTM separates tags with commas. */
export function normalizeTag(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-').replace(/,/g, '');
}

/**
 * The project a Claude Code session is running in, as an RTM tag.
 *
 * Claude Code starts this server with the project directory as cwd, so the
 * directory name is the project name: the git root when inside a repo (so a
 * subdirectory still maps to the same project), otherwise the cwd itself.
 * The home directory and / are not projects. RTM_PROJECT overrides all of
 * this; an empty RTM_PROJECT disables project tagging altogether.
 */
export function detectProject(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string | undefined {
  if (env.RTM_PROJECT !== undefined) {
    return normalizeTag(env.RTM_PROJECT) || undefined;
  }

  const resolvedHome = resolve(home);
  const repoRoot = findRepoRoot(cwd);
  // A dotfiles repo in $HOME would otherwise claim every directory under it.
  const dir = repoRoot && repoRoot !== resolvedHome ? repoRoot : resolve(cwd);

  if (dir === resolvedHome || dirname(dir) === dir) return undefined;
  return normalizeTag(basename(dir)) || undefined;
}
