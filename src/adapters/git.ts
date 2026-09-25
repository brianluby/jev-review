// Git adapter: discovers changed source files under a scope and returns each
// one with a unified diff. Untracked files are rendered as all-additions.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { SOURCE_FILE } from "../domain/config.ts";
import { patchForNewFile } from "../domain/patch.ts";
import type { ChangedFile } from "../domain/types.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function lines(output: string): string[] {
  return output.split("\n").filter(Boolean);
}

// Reads an untracked path only when it is a regular file inside repoRoot.
// Symlinks (O_NOFOLLOW), non-regular files, and escapes resolve to null;
// unexpected I/O failures throw so scans never silently lose input.
function readRepoFile(repoRoot: string, path: string): string | null {
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(repoRoot + sep)) return null;
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isBenignOpenError(error)) return null;
    throw error;
  }
  let file: { dev: number; ino: number; size: number } | null = null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const real = realpathSync(absolute);
    if (real !== absolute && !real.startsWith(repoRoot + sep)) return null;
    file = { dev: stat.dev, ino: stat.ino, size: stat.size };
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
    if (file) assertSameFile(absolute, file);
  }
}

// Ancestor swaps between open and read are a live-mutation race, not review
// input; fail loudly rather than misattribute content to the reported path.
function assertSameFile(absolute: string, file: { dev: number; ino: number; size: number }): void {
  let current: { dev: number; ino: number; size: number } | null = null;
  try {
    const stat = statSync(absolute);
    if (stat.isFile()) current = { dev: stat.dev, ino: stat.ino, size: stat.size };
  } catch (error) {
    if (!isBenignOpenError(error)) throw error;
  }
  if (!current || current.dev !== file.dev || current.ino !== file.ino || current.size !== file.size) {
    throw new Error(`File changed during read: ${absolute}`);
  }
}

// Symlink encountered (ELOOP), vanished path (ENOENT), or a special file that
// is not openable: expected races against a live worktree, safe to skip.
function isBenignOpenError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "ENOENT" || code === "ENXIO" || code === "ENODEV";
}

export function changedFiles(scope: string): ChangedFile[] {
  const realScope = realpathSync(scope);
  const repoRoot = realpathSync(git(realScope, ["rev-parse", "--show-toplevel"]).trim());
  const relativeScope = relative(repoRoot, realScope) || ".";

  const tracked = lines(
    git(repoRoot, [
      "diff",
      "HEAD",
      "--name-only",
      "--diff-filter=ACMRTUXB",
      "--",
      relativeScope,
    ]),
  );
  const untracked = lines(
    git(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", relativeScope]),
  );

  const untrackedSet = new Set(untracked);
  const paths = [...new Set([...tracked, ...untracked])].filter((path) =>
    SOURCE_FILE.test(path),
  );

  return paths.flatMap((path) => {
    if (!untrackedSet.has(path)) {
      return [{ path, patch: git(repoRoot, ["diff", "HEAD", "--unified=3", "--", path]) }];
    }
    const content = readRepoFile(repoRoot, path);
    return content === null ? [] : [{ path, patch: patchForNewFile(content) }];
  });
}
