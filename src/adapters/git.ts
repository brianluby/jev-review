// Git adapter: discovers changed source files under a scope and returns each
// one with a unified diff. Untracked files are rendered as all-additions.
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
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
