// Git-backed source discovery for complete codebase scans. Tracked and
// untracked, non-ignored JavaScript and TypeScript files are included.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { SOURCE_FILE } from "../domain/config.ts";
import type { SourceFile } from "../domain/types.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Reads a git-reported path only when it is a regular file inside repoRoot.
// Symlinks (O_NOFOLLOW), special files, and escapes resolve to null.
function readRepoFile(repoRoot: string, path: string): string | null {
  const absolute = resolve(repoRoot, path);
  if (!absolute.startsWith(repoRoot + sep)) return null;
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const real = realpathSync(absolute);
    if (real !== absolute && !real.startsWith(repoRoot + sep)) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function repositoryFiles(scope: string): SourceFile[] {
  const realScope = realpathSync(scope);
  const repoRoot = realpathSync(git(realScope, ["rev-parse", "--show-toplevel"]).trim());
  const relativeScope = relative(repoRoot, realScope) || ".";
  const paths = git(repoRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    relativeScope,
  ])
    .split("\n")
    .filter((path) => path.length > 0 && SOURCE_FILE.test(path));

  return paths.flatMap((path) => {
    const content = readRepoFile(repoRoot, path);
    return content === null ? [] : [{ path, content }];
  });
}
