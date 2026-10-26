import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export const MANIFEST = join(".factory", "repo.yml");
export const SPEC = ".factory/spec.md";

export type Manifest = { acceptanceTests: string };

/** Walks up from `start` to the nearest directory holding a Repo manifest, or null if none. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, MANIFEST))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Reads the parts of the Repo manifest the Factory acts on. Throws on an unusable manifest. */
export function readManifest(root: string): Manifest {
  const doc = parse(readFileSync(join(root, MANIFEST), "utf8")) as {
    paths?: { acceptance_tests?: unknown };
  } | null;
  const acceptanceTests = doc?.paths?.acceptance_tests;
  if (typeof acceptanceTests !== "string" || acceptanceTests.trim() === "") {
    throw new Error(`${MANIFEST} does not declare paths.acceptance_tests`);
  }
  return {
    acceptanceTests: acceptanceTests
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\/|\/+$/g, ""),
  };
}
