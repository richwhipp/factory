import { describe, expect, it } from "vitest";
import { factory, gitRepo, MANIFEST_V1 } from "./run.ts";

function ticketBranch(manifest?: string) {
  const repo = gitRepo(manifest);
  repo.git("switch", "-q", "-c", "factory/12-notes");
  const check = (...args: string[]) => factory(["order-check", ...args], { cwd: repo.root });
  return { ...repo, check };
}

describe("order-check", () => {
  it("passes Acceptance commits followed by commits that leave them alone", () => {
    const b = ticketBranch();
    b.commit("Acceptance: add a note", { "acceptance/add-note.spec.ts": "test" });
    b.commit("Acceptance: list notes", { "acceptance/list.spec.ts": "test" });
    b.commit("Build notes", { "src/app.ts": "code" });

    const res = b.check();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ok \(2 Acceptance commit\(s\), then 1 other\(s\)/);
  });

  it("passes a branch with no Acceptance commits", () => {
    const b = ticketBranch();
    b.commit("Fix a typo", { "src/app.ts": "code" });
    expect(b.check().status).toBe(0);
  });

  it("fails an Acceptance commit that touches anything else, naming the commit and path", () => {
    const b = ticketBranch();
    b.commit("Acceptance and a sneaky fix", { "acceptance/a.spec.ts": "t", "src/app.ts": "c" });

    const res = b.check();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/[0-9a-f]{7} "Acceptance and a sneaky fix" touches src\/app.ts/);
  });

  it("fails a later commit that changes or deletes an Acceptance test", () => {
    const b = ticketBranch();
    b.commit("Acceptance", { "acceptance/a.spec.ts": "t" });
    b.commit("Build", { "src/app.ts": "c" });
    b.commit("Loosen the test", { "acceptance/a.spec.ts": "weaker" });
    b.commit("Drop a test", { "acceptance/notes.spec.ts": null });

    const res = b.check();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/"Loosen the test" touches acceptance\/a.spec.ts/);
    expect(res.stdout).toMatch(/"Drop a test" touches acceptance\/notes.spec.ts/);
  });

  it("fails any commit that touches the Spec, Acceptance commits included", () => {
    const b = ticketBranch();
    b.commit("Acceptance with Spec edit", { "acceptance/a.spec.ts": "t", ".factory/spec.md": "x" });
    b.commit("Build with Spec edit", { "src/app.ts": "c", ".factory/spec.md": "y" });

    const res = b.check();
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/"Acceptance with Spec edit" touches .factory\/spec.md/);
    expect(res.stdout).toMatch(/"Build with Spec edit" touches .factory\/spec.md/);
  });

  it("checks a new-attempt branch cut from main the same way", () => {
    const b = ticketBranch();
    b.commit("Acceptance", { "acceptance/a.spec.ts": "t" });
    b.commit("Build", { "src/app.ts": "c" });
    b.git("switch", "-q", "main");
    b.git("switch", "-q", "-c", "factory/12-notes-r2");
    b.commit("Acceptance, rewritten", { "acceptance/a.spec.ts": "t2" });
    b.commit("Build again", { "src/app.ts": "c2" });

    const res = b.check();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/1 Acceptance commit\(s\), then 1 other\(s\)/);
  });

  it("ignores Acceptance changes merged in from main", () => {
    const b = ticketBranch();
    b.commit("Acceptance", { "acceptance/a.spec.ts": "t" });
    b.commit("Build", { "src/app.ts": "c" });
    b.git("switch", "-q", "main");
    b.commit("Another Ticket's Acceptance", { "acceptance/other.spec.ts": "t" });
    b.git("switch", "-q", "factory/12-notes");
    b.git("merge", "-q", "--no-edit", "main");

    expect(b.check().status).toBe(0);
  });

  it("compares against --base when given", () => {
    const b = ticketBranch();
    b.commit("Build", { "src/app.ts": "c" });
    b.git("tag", "built");
    b.commit("Acceptance", { "acceptance/a.spec.ts": "t" });

    expect(b.check().status).toBe(1);
    expect(b.check("--base", "built").status).toBe(0);
  });

  it("reads the Acceptance tests path from the Repo manifest", () => {
    const b = ticketBranch(
      MANIFEST_V1.replace("acceptance_tests: acceptance", "acceptance_tests: tests/e2e"),
    );
    b.commit("Acceptance", { "tests/e2e/flow.spec.ts": "t" });
    b.commit("Build", { "src/app.ts": "c" });
    b.commit("Change the old folder", { "acceptance/notes.spec.ts": "not protected here" });
    expect(b.check().status).toBe(0);

    b.commit("Change the e2e test", { "tests/e2e/flow.spec.ts": "weaker" });
    expect(b.check().status).toBe(1);
  });

  it("exits 2 outside a Factory Repo", () => {
    const res = factory(["order-check"], { cwd: process.env.TEMP ?? "/" });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/no Repo manifest/);
  });
});
