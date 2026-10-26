import { spawnSync } from "node:child_process";
import { readManifest, SPEC } from "./repo.ts";

export type Violation = { sha: string; subject: string; path: string; rule: string };
export type OrderResult = {
  base: string;
  acceptanceCommits: number;
  laterCommits: number;
  violations: Violation[];
};

function git(root: string, args: string[]): string {
  // Paths print unquoted, so non-ASCII file names compare as written.
  const res = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

const lines = (s: string) => s.split("\n").filter(Boolean);

/** Where the branch left `ref` (default: origin/<default_branch>, else <default_branch>). */
function resolveBase(root: string, ref: string | undefined, defaultBranch: string): string {
  const candidates = ref ? [ref] : [`origin/${defaultBranch}`, defaultBranch];
  for (const candidate of candidates) {
    const res = spawnSync("git", ["merge-base", candidate, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    if (res.status === 0) return res.stdout.trim();
  }
  throw new Error(`no base found: none of ${candidates.join(", ")} shares history with HEAD`);
}

/**
 * Checks a Ticket branch's commit order: its Acceptance commits come first and touch only
 * the Acceptance tests path; no later commit touches that path or the Spec. Commits are the
 * branch's own (first-parent, merges skipped), so merging the default branch in is fine.
 */
export function orderCheck(root: string, baseRef?: string): OrderResult {
  const { acceptanceTests, defaultBranch } = readManifest(root);
  const base = resolveBase(root, baseRef, defaultBranch);
  const shas = lines(
    git(root, ["rev-list", "--reverse", "--first-parent", "--no-merges", `${base}..HEAD`]),
  );

  const inAcceptance = (p: string) => p === acceptanceTests || p.startsWith(`${acceptanceTests}/`);
  const violations: Violation[] = [];
  let acceptanceCommits = 0;
  let leading = true;

  for (const sha of shas) {
    const subject = git(root, ["log", "-1", "--format=%s", sha]).trim();
    const paths = lines(
      git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]),
    );
    const short = sha.slice(0, 7);
    const add = (path: string, rule: string) =>
      violations.push({ sha: short, subject, path, rule });

    if (leading && paths.length > 0 && paths.some(inAcceptance)) {
      acceptanceCommits++;
      for (const p of paths.filter((p) => !inAcceptance(p))) {
        add(p, `an Acceptance commit may touch only ${acceptanceTests}/`);
      }
      continue;
    }

    leading = false;
    for (const p of paths) {
      if (inAcceptance(p))
        add(p, `${acceptanceTests}/ may change only in the branch's first commits`);
      else if (p === SPEC) add(p, "the Spec may not change on a Ticket branch");
    }
  }

  return { base, acceptanceCommits, laterCommits: shas.length - acceptanceCommits, violations };
}
