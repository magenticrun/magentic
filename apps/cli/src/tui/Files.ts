import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

const normalisePath = (path: string): string => (sep === "\\" ? path.replaceAll("\\", "/") : path);

const usable = (path: string): boolean =>
  path.length > 0 && !path.includes("\n") && !path.includes("\r");

const gitFiles = async (directory: string): Promise<ReadonlyArray<string> | undefined> => {
  try {
    const child = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return exit === 0 ? text.split("\0").filter(usable) : undefined;
  } catch {
    return undefined;
  }
};

const walkedFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const files: Array<string> = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop() ?? "";
    let entries;
    try {
      entries = await readdir(join(directory, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = relative.length === 0 ? entry.name : join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          pending.push(path);
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const normalised = normalisePath(path);
        if (usable(normalised)) {
          files.push(normalised);
        }
      }
    }
  }
  return files;
};

export const listWorkspaceFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const files = (await gitFiles(directory)) ?? (await walkedFiles(directory));
  return [...new Set(files)].toSorted((a, b) => a.localeCompare(b));
};
