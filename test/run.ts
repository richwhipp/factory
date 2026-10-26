import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Tests run the built bundle: the same file the installed hook runs.
const cli = resolve(import.meta.dirname, "../dist/factory.mjs");

/** Runs the `factory` CLI as a separate process, the way hooks and scripts call it. */
export function factory(
  args: string[],
  opts: { stdin?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd,
    input: opts.stdin ?? "",
    encoding: "utf8",
    env: { ...process.env, FACTORY_ROLE: "", ...opts.env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Like `factory`, but without blocking the test process, for commands that call a fake
 * server running inside it.
 */
export function factoryAsync(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, FACTORY_ROLE: "", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
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

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** A git Repo on disk, starting with one commit on `main` holding the manifest (if any) and files. */
export function gitRepo(
  manifest: string | null = MANIFEST_V1,
  files: Record<string, string> = { "src/app.ts": "", "acceptance/notes.spec.ts": "" },
) {
  const root = fixtureRepo(manifest, files);
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd: root, encoding: "utf8", env: GIT_ENV });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "Initial Repo");

  /** Writes (or, with `null`, deletes) the given files, then commits them. */
  const commit = (message: string, files: Record<string, string | null>) => {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) git("rm", "-q", path);
      else {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
        git("add", path);
      }
    }
    git("commit", "-q", "-m", message);
  };

  return { root, git, commit };
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
