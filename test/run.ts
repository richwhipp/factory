import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Tests run the built bundle: the same file the installed hook runs.
const cli = resolve(import.meta.dirname, "../dist/factory.mjs");

/** Runs the `factory` CLI as a separate process, the way hooks and scripts call it. */
export function factory(args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    input: opts.stdin ?? "",
    encoding: "utf8",
    env: { ...process.env, FACTORY_ROLE: "", ...opts.env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Builds a throwaway Repo on disk: an optional Repo manifest plus the given files. */
export function fixtureRepo(manifest: string | null, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
  const all = manifest === null ? files : { ...files, ".factory/repo.yml": manifest };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

export const MANIFEST_V1 = `contract_version: 1
default_branch: main
commands:
  setup: pnpm install
  verify: pnpm run verify
  acceptance: pnpm exec playwright test
paths:
  acceptance_tests: acceptance
`;
