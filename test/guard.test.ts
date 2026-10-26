import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factory, fixtureRepo, MANIFEST_V1 } from "./run.ts";

type Call = { tool: string; input: Record<string, unknown>; cwd: string; agent?: string };

function guard(call: Call, env: NodeJS.ProcessEnv = {}) {
  const res = factory(["guard"], {
    stdin: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: call.tool,
      tool_input: call.input,
      cwd: call.cwd,
      ...(call.agent ? { agent_id: "a1", agent_type: call.agent } : {}),
    }),
    env,
  });
  expect(res.status).toBe(0);
  if (res.stdout === "") return { denied: false, reason: "" };
  const out = JSON.parse(res.stdout).hookSpecificOutput;
  expect(out.hookEventName).toBe("PreToolUse");
  return {
    denied: out.permissionDecision === "deny",
    reason: String(out.permissionDecisionReason),
  };
}

const repo = fixtureRepo(MANIFEST_V1, { "acceptance/notes.spec.ts": "", "src/app.ts": "" });
const write = (file_path: string, agent?: string) =>
  guard({ tool: "Write", input: { file_path, content: "x" }, cwd: repo, agent });
const bash = (command: string, agent?: string, cwd = repo) =>
  guard({ tool: "Bash", input: { command }, cwd, agent });

describe("guard: file edits", () => {
  it("denies the builder writing an Acceptance test, by relative or absolute path", () => {
    expect(write("acceptance/notes.spec.ts").denied).toBe(true);
    expect(write(join(repo, "acceptance", "new.spec.ts")).denied).toBe(true);
    expect(write("acceptance/notes.spec.ts").reason).toMatch(/Acceptance dispute/);
  });

  it("denies Edit, MultiEdit and NotebookEdit on Acceptance tests too", () => {
    for (const tool of ["Edit", "MultiEdit"]) {
      const res = guard({ tool, input: { file_path: "acceptance/notes.spec.ts" }, cwd: repo });
      expect(res.denied, tool).toBe(true);
    }
    const nb = guard({
      tool: "NotebookEdit",
      input: { notebook_path: "acceptance/n.ipynb" },
      cwd: repo,
    });
    expect(nb.denied).toBe(true);
  });

  it("allows the builder to edit code outside the protected paths", () => {
    expect(write("src/app.ts").denied).toBe(false);
    expect(write("acceptance-helpers/util.ts").denied).toBe(false);
  });

  it("allows the Acceptance subagent to write Acceptance tests", () => {
    expect(write("acceptance/notes.spec.ts", "acceptance").denied).toBe(false);
  });

  it("allows an Acceptance session marked by FACTORY_ROLE", () => {
    const res = guard(
      { tool: "Write", input: { file_path: "acceptance/notes.spec.ts" }, cwd: repo },
      { FACTORY_ROLE: "acceptance" },
    );
    expect(res.denied).toBe(false);
  });

  it("denies everyone, the Acceptance subagent included, editing the Spec", () => {
    expect(write(".factory/spec.md").denied).toBe(true);
    expect(write(".factory/spec.md", "acceptance").denied).toBe(true);
  });

  it("denies every agent, the Acceptance subagent included, editing CI workflows", () => {
    expect(write(".github/workflows/ci.yml").denied).toBe(true);
    expect(write(".github/workflows/ci.yml", "acceptance").denied).toBe(true);
    expect(write(".github/workflows/ci.yml").reason).toMatch(/Operator's call/);
    expect(write(".github/dependabot.yml").denied).toBe(false);
    expect(bash("sed -i 's/order-check/true/' .github/workflows/ci.yml").denied).toBe(true);
    expect(bash("cat .github/workflows/ci.yml").denied).toBe(false);
  });

  it("does not let another subagent pass as the Acceptance subagent", () => {
    expect(write("acceptance/notes.spec.ts", "review").denied).toBe(true);
  });

  it("finds the Repo from a nested working directory", () => {
    const res = guard({
      tool: "Write",
      input: { file_path: "../acceptance/x.spec.ts" },
      cwd: join(repo, "src"),
    });
    expect(res.denied).toBe(true);
  });

  it("reads the Acceptance tests path from the Repo manifest", () => {
    const custom = fixtureRepo(
      MANIFEST_V1.replace("acceptance_tests: acceptance", "acceptance_tests: tests/e2e"),
    );
    const w = (file_path: string) =>
      guard({ tool: "Write", input: { file_path }, cwd: custom }).denied;
    expect(w("tests/e2e/flow.spec.ts")).toBe(true);
    expect(w("tests/unit/x.test.ts")).toBe(false);
    expect(w("acceptance/x.spec.ts")).toBe(false);
  });

  it("allows anything outside a Factory Repo", () => {
    const plain = fixtureRepo(null, { "acceptance/x.spec.ts": "" });
    const res = guard({ tool: "Write", input: { file_path: "acceptance/x.spec.ts" }, cwd: plain });
    expect(res.denied).toBe(false);
  });

  it("blocks edits when the Repo manifest has no Acceptance tests path", () => {
    const broken = fixtureRepo("contract_version: 1\n");
    const res = guard({ tool: "Write", input: { file_path: "src/a.ts" }, cwd: broken });
    expect(res.denied).toBe(true);
    expect(res.reason).toMatch(/acceptance_tests/);
  });

  it("lets other tools through", () => {
    const res = guard({
      tool: "Read",
      input: { file_path: "acceptance/notes.spec.ts" },
      cwd: repo,
    });
    expect(res.denied).toBe(false);
  });

  it("blocks the call when the hook input is not JSON", () => {
    const res = factory(["guard"], { stdin: "not json" });
    expect(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("guard: Bash", () => {
  it("denies every form of force-push, for everyone, anywhere", () => {
    const plain = fixtureRepo(null);
    for (const cmd of [
      "git push --force",
      "git push -f origin main",
      "git push -uf origin x",
      "git push --force-with-lease",
      "git push --force-with-lease=main:abc",
      "git push origin +main",
      "git add . && git commit -m x && git push --force",
    ]) {
      expect(bash(cmd).denied, cmd).toBe(true);
      expect(bash(cmd, "acceptance", plain).denied, cmd).toBe(true);
    }
  });

  it("allows ordinary pushes", () => {
    expect(bash("git push origin factory/12-notes").denied).toBe(false);
    expect(bash("git push -u origin factory/12-notes").denied).toBe(false);
  });

  it("denies the builder changing Acceptance tests from the shell", () => {
    for (const cmd of [
      "rm acceptance/notes.spec.ts",
      "echo 'x' > acceptance/notes.spec.ts",
      "sed -i 's/a/b/' acceptance/notes.spec.ts",
      "git checkout -- acceptance",
      "mv acceptance/notes.spec.ts /tmp/",
      "cd acceptance && rm notes.spec.ts",
      `rm ${join(repo, "acceptance", "notes.spec.ts").replace(/\\/g, "/")}`,
    ]) {
      expect(bash(cmd).denied, cmd).toBe(true);
    }
  });

  it("denies changing the Spec from the shell, even for the Acceptance subagent", () => {
    expect(bash("rm .factory/spec.md", "acceptance").denied).toBe(true);
  });

  it("allows reading and running Acceptance tests", () => {
    for (const cmd of [
      "cat acceptance/notes.spec.ts",
      "git diff main -- acceptance",
      "pnpm exec playwright test acceptance/notes.spec.ts",
      "pnpm run acceptance acceptance/notes.spec.ts",
      "ls acceptance",
      "grep -r getByRole acceptance",
    ]) {
      expect(bash(cmd).denied, cmd).toBe(false);
    }
  });

  it("allows the Acceptance subagent to change Acceptance tests from the shell", () => {
    expect(bash("rm acceptance/notes.spec.ts", "acceptance").denied).toBe(false);
  });

  it("allows commands that don't touch protected paths", () => {
    expect(bash("pnpm run verify && git commit -am 'Build notes'").denied).toBe(false);
  });

  it("allows commit messages that mention protected paths, inline or in a heredoc", () => {
    const inline = `git add -A && git commit -q -m "Run order-check on every PR

Fails the PR if a later commit touches acceptance/ or
the Spec (.factory/spec.md)." && git push -q`;
    expect(bash(inline).denied).toBe(false);

    const heredoc = `git commit -F - <<'EOF'
Touches acceptance/notes.spec.ts > nowhere
rm acceptance/notes.spec.ts
EOF
git log -1`;
    expect(bash(heredoc).denied).toBe(false);
  });

  it("still sees protected paths inside quotes, and redirects into them", () => {
    expect(bash(`rm "acceptance/notes.spec.ts"`).denied).toBe(true);
    expect(bash("cat <<'EOF' > acceptance/x.spec.ts\ntest\nEOF").denied).toBe(true);
    expect(bash("printf x >> acceptance/notes.spec.ts").denied).toBe(true);
  });

  it("allows descriptor redirects such as 2>&1 alongside a test run", () => {
    expect(bash("pnpm exec playwright test acceptance/notes.spec.ts 2>&1 | tail -5").denied).toBe(
      false,
    );
  });

  it("treats every command run from inside the Acceptance tests directory as touching it", () => {
    const inside = join(repo, "acceptance");
    expect(bash("rm notes.spec.ts", undefined, inside).denied).toBe(true);
    expect(bash("cat notes.spec.ts", undefined, inside).denied).toBe(false);
    expect(bash("echo x > notes.spec.ts", undefined, inside).denied).toBe(true);
  });
});
