import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGitHub, type FakeRepo } from "./fake-github.ts";
import { factoryAsync, gitRepo } from "./run.ts";

/** Runs every file under acceptance/ with node; any failure fails Verify. */
const VERIFY = `import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
for (const f of readdirSync("acceptance")) {
  const r = spawnSync(process.execPath, ["acceptance/" + f], { stdio: "inherit" });
  if (r.status !== 0) process.exit(1);
}
`;

const manifest = (
  over: { setup?: string; verify?: string; extra?: string } = {},
) => `contract_version: 1
default_branch: main
commands:
  setup: ${over.setup ?? "node scripts/setup.mjs"}
  verify: ${over.verify ?? "node scripts/verify.mjs"}
  acceptance: node scripts/verify.mjs
${over.extra ?? ""}paths:
  acceptance_tests: acceptance
`;

/** A Repo that meets the whole contract locally; pass overrides to break one rule. */
function compliantRepo(files: Record<string, string | null> = {}, manifestText = manifest()) {
  const base: Record<string, string | null> = {
    "CLAUDE.md": "# CLAUDE.md\n",
    "CONTEXT.md": "# Context\n",
    "scripts/setup.mjs": "console.log('set up');\n",
    "scripts/verify.mjs": VERIFY,
    "acceptance/notes.test.mjs": "console.log('notes ok');\n",
    "src/app.mjs": "export {};\n",
    ...files,
  };
  const present = Object.fromEntries(
    Object.entries(base).filter((e): e is [string, string] => e[1] !== null),
  );
  const repo = gitRepo(manifestText, present);
  repo.git("remote", "add", "origin", "https://github.com/test/app.git");
  return repo;
}

let gh: FakeGitHub;
beforeAll(async () => {
  gh = await new FakeGitHub().start();
});
afterAll(() => gh.stop());

async function check(root: string, github: Partial<FakeRepo> | null = {}, args: string[] = []) {
  gh.repos.clear();
  if (github) gh.addCompliantRepo("test/app", github);
  const res = await factoryAsync(["contract-check", ...args], {
    cwd: root,
    env: { FACTORY_GITHUB_API: gh.url, FACTORY_GITHUB_TOKEN: "test-token" },
  });
  const failed = (rule: RegExp) =>
    res.stdout.split("\n").some((l) => l.includes("FAIL") && rule.test(l));
  return { ...res, failed };
}

describe("contract-check", () => {
  it("passes a Repo that meets every rule", async () => {
    const res = await check(compliantRepo().root);
    expect(res.stdout).toMatch(/contract-check: ok/);
    expect(res.stdout).not.toMatch(/FAIL/);
    expect(res.status).toBe(0);
  });

  it("fails an incomplete Repo manifest, naming what is missing, and runs no commands", async () => {
    const text = manifest().replace("  acceptance: node scripts/verify.mjs\n", "");
    const res = await check(compliantRepo({}, text).root);
    expect(res.status).toBe(1);
    expect(res.failed(/Repo manifest is valid: commands.acceptance is missing/)).toBe(true);
    expect(res.failed(/not run: the Repo manifest is invalid/)).toBe(true);
  });

  it("fails an unsupported contract_version", async () => {
    const res = await check(
      compliantRepo({}, manifest().replace("contract_version: 1", "contract_version: 2")).root,
    );
    expect(res.failed(/contract_version is 2; supported: 1/)).toBe(true);
  });

  it("fails a Repo with no committed Repo manifest", async () => {
    const repo = gitRepo(null, { "CLAUDE.md": "", "CONTEXT.md": "" });
    repo.git("remote", "add", "origin", "https://github.com/test/app.git");
    const res = await check(repo.root);
    expect(res.failed(/.factory.repo.yml is not committed/)).toBe(true);
  });

  it("fails a failing Setup and shows its output", async () => {
    const res = await check(
      compliantRepo({ "scripts/setup.mjs": "console.error('no network'); process.exit(3);\n" })
        .root,
    );
    expect(res.failed(/Setup passes on a clean checkout: setup exited 3/)).toBe(true);
    expect(res.stdout).toMatch(/no network/);
  });

  it("fails a Setup that waits for input, after the timeout", async () => {
    const res = await check(
      compliantRepo({ "scripts/setup.mjs": "setInterval(() => {}, 1000);\n" }).root,
      {},
      ["--timeout", "3"],
    );
    expect(res.failed(/setup timed out after 3s \(does it wait for input\?\)/)).toBe(true);
  });

  it("fails a failing Verify", async () => {
    const res = await check(
      compliantRepo({ "acceptance/notes.test.mjs": "process.exit(1);\n" }).root,
    );
    expect(res.failed(/Verify passes on a clean checkout: verify exited 1/)).toBe(true);
  });

  it("fails a Verify that changes tracked files", async () => {
    const verify = `import { writeFileSync } from "node:fs";\nwriteFileSync("src/app.mjs", "// formatted\\n");\n${VERIFY}`;
    const res = await check(compliantRepo({ "scripts/verify.mjs": verify }).root);
    expect(res.failed(/Verify changes no tracked files: changed:/)).toBe(true);
    expect(res.stdout).toMatch(/src\/app.mjs/);
  });

  it("fails a Verify that doesn't run every Acceptance test", async () => {
    const res = await check(
      compliantRepo({ "scripts/verify.mjs": "console.log('all good');\n" }).root,
    );
    expect(
      res.failed(
        /Verify fails when a failing Acceptance test is planted: verify still passed with factory-planted-notes.test.mjs planted/,
      ),
    ).toBe(true);
  });

  it("checks the committed state, not uncommitted files", async () => {
    const repo = compliantRepo();
    repo.git("rm", "-q", "CONTEXT.md");
    repo.git("commit", "-q", "-m", "Drop CONTEXT.md");
    const res = await check(repo.root);
    expect(res.failed(/CLAUDE.md and CONTEXT.md exist: missing: CONTEXT.md/)).toBe(true);
  });

  it("fails when GitHub Issues are off", async () => {
    const res = await check(compliantRepo().root, { has_issues: false });
    expect(res.failed(/GitHub Issues are enabled/)).toBe(true);
  });

  it("fails when Factory labels are missing, naming them", async () => {
    const res = await check(compliantRepo().root, { labels: ["factory:run", "bug"] });
    expect(res.failed(/Factory labels exist: missing: factory:ticket, factory:building/)).toBe(
      true,
    );
  });

  it("fails each gap in branch protection", async () => {
    const root = compliantRepo().root;
    expect((await check(root, { protection: {} })).failed(/the branch is not protected/)).toBe(
      true,
    );
    const weak = {
      main: {
        required_status_checks: { contexts: [] },
        allow_force_pushes: { enabled: true },
      },
    };
    const res = await check(root, { protection: weak });
    expect(
      res.failed(
        /pull requests are not required; no status checks are required; force-pushes are allowed/,
      ),
    ).toBe(true);
  });

  it("fails when CI hasn't passed on the default branch", async () => {
    const root = compliantRepo().root;
    expect((await check(root, { checkRuns: {} })).failed(/no CI status on main/)).toBe(true);
    const red = { main: [{ name: "verify", status: "completed", conclusion: "failure" }] };
    expect((await check(root, { checkRuns: red })).failed(/CI failed: verify/)).toBe(true);
    const running = { main: [{ name: "verify", status: "in_progress", conclusion: null }] };
    expect((await check(root, { checkRuns: running })).failed(/CI still running: verify/)).toBe(
      true,
    );
  });

  it("fails when the manifest's default branch isn't GitHub's", async () => {
    const res = await check(compliantRepo().root, { default_branch: "trunk" });
    expect(
      res.failed(/Default branch matches the Repo manifest: GitHub's is trunk, manifest says main/),
    ).toBe(true);
  });

  it("fails without a GitHub remote, or when GitHub doesn't know the repo", async () => {
    const repo = compliantRepo();
    expect((await check(repo.root, null)).failed(/GitHub remote: test\/app not found/)).toBe(true);
    repo.git("remote", "set-url", "origin", "https://gitlab.com/test/app.git");
    expect((await check(repo.root)).failed(/origin is not a GitHub repository/)).toBe(true);
  });

  it("asks GitHub only through REST GETs", async () => {
    await check(compliantRepo().root);
    expect(gh.calls.length).toBeGreaterThan(0);
    expect(gh.calls.every((c) => c.method === "GET" && c.path.startsWith("/repos/test/app"))).toBe(
      true,
    );
  });
});
