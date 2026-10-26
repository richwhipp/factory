import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";
import { type GitHub, repoSlug } from "./github.ts";
import { FACTORY_LABELS } from "./labels.ts";
import { MANIFEST } from "./repo.ts";
import { type CommandResult, runDeclared, tail } from "./shell.ts";

export const SUPPORTED_CONTRACT_VERSIONS = [1];

export type RuleResult = { rule: string; ok: boolean; detail?: string };
export type ContractResult = { slug: string | null; contractVersion: unknown; rules: RuleResult[] };

type Manifest = {
  defaultBranch: string;
  commands: { setup: string; verify: string };
  acceptanceTests: string;
};

/** Validates the Repo manifest against contract v1. Returns the parts the check acts on, or the problems. */
function validateManifest(doc: unknown): { manifest: Manifest } | { problems: string[] } {
  const problems: string[] = [];
  const d = (doc ?? {}) as Record<string, unknown>;
  const commands = (d.commands ?? {}) as Record<string, unknown>;
  const paths = (d.paths ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.trim() !== "";

  if (!SUPPORTED_CONTRACT_VERSIONS.includes(d.contract_version as number)) {
    problems.push(
      `contract_version is ${JSON.stringify(d.contract_version)}; supported: ${SUPPORTED_CONTRACT_VERSIONS.join(", ")}`,
    );
  }
  if (!str(d.default_branch)) problems.push("default_branch is missing");
  for (const name of ["setup", "verify", "acceptance"]) {
    if (!str(commands[name])) problems.push(`commands.${name} is missing`);
  }
  for (const name of ["test", "lint", "format", "build"]) {
    if (name in commands && !str(commands[name]))
      problems.push(`commands.${name} must be a command`);
  }
  const acceptance = paths.acceptance_tests;
  if (!str(acceptance)) problems.push("paths.acceptance_tests is missing");
  else if (/^([/\\]|[A-Za-z]:)|(^|[/\\])\.\.([/\\]|$)/.test(acceptance as string)) {
    problems.push("paths.acceptance_tests must be a path inside the Repo");
  }

  if (problems.length) return { problems };
  return {
    manifest: {
      defaultBranch: d.default_branch as string,
      commands: { setup: commands.setup as string, verify: commands.verify as string },
      acceptanceTests: (acceptance as string).replace(/\\/g, "/").replace(/^\.\/|\/+$/g, ""),
    },
  };
}

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8" });

function firstFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      const inner = firstFile(path);
      if (inner) return inner;
    } else return path;
  }
  return null;
}

/**
 * The Contract check: does this Repo meet Repo contract v1? Runs the declared commands on a
 * clean checkout of HEAD and inspects the GitHub side through the REST API.
 */
export async function contractCheck(
  root: string,
  opts: { github: GitHub; timeoutSeconds: number; slug?: string },
): Promise<ContractResult> {
  const rules: RuleResult[] = [];
  const add = (rule: string, ok: boolean, detail?: string) => rules.push({ rule, ok, detail });

  // --- The Repo manifest
  let doc: unknown = null;
  const committed = git(root, "show", `HEAD:${MANIFEST.replace(/\\/g, "/")}`);
  if (committed.status !== 0) {
    add("Repo manifest is valid", false, `${MANIFEST} is not committed`);
  } else {
    try {
      doc = parse(committed.stdout) ?? {};
    } catch (e) {
      add("Repo manifest is valid", false, `not valid YAML: ${(e as Error).message}`);
    }
  }
  const contractVersion = (doc as Record<string, unknown> | null)?.contract_version;
  const validated = doc === null ? null : validateManifest(doc);
  if (validated && "problems" in validated) {
    add("Repo manifest is valid", false, validated.problems.join("; "));
  } else if (validated) add("Repo manifest is valid", true);
  const manifest = validated && "manifest" in validated ? validated.manifest : null;

  // --- A clean checkout of HEAD: files and declared commands
  const scratch = mkdtempSync(join(tmpdir(), "contract-check-"));
  const checkout = join(scratch, "repo");
  try {
    const cloned = git(scratch, "clone", "--quiet", "--no-hardlinks", root, checkout);
    if (cloned.status !== 0) throw new Error(`could not clone the Repo: ${cloned.stderr}`);

    const missing = ["CLAUDE.md", "CONTEXT.md"].filter((f) => !existsSync(join(checkout, f)));
    add(
      "CLAUDE.md and CONTEXT.md exist",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : undefined,
    );

    if (!manifest) {
      add(
        "Setup and Verify pass on a clean checkout",
        false,
        "not run: the Repo manifest is invalid",
      );
    } else {
      await checkCommands(checkout, manifest, opts.timeoutSeconds, add);
    }
  } finally {
    // Best effort: on Windows a killed command can hold files a moment longer.
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      // Left in the temp directory.
    }
  }

  // --- GitHub
  const remote = git(root, "remote", "get-url", "origin").stdout;
  const slug = opts.slug ?? repoSlug(remote);
  if (!slug) {
    add(
      "GitHub remote",
      false,
      `origin is not a GitHub repository (${remote.trim() || "no origin"})`,
    );
  } else {
    await checkGitHub(opts.github, slug, manifest?.defaultBranch, add);
  }

  return { slug, contractVersion, rules };
}

async function checkCommands(
  checkout: string,
  manifest: Manifest,
  timeoutSeconds: number,
  add: (rule: string, ok: boolean, detail?: string) => void,
) {
  const failure = (what: string, r: CommandResult) =>
    r.timedOut
      ? `${what} timed out after ${timeoutSeconds}s (does it wait for input?)`
      : `${what} exited ${r.status}:\n${tail(r.output)}`;

  const setup = await runDeclared(manifest.commands.setup, checkout, timeoutSeconds);
  add("Setup passes on a clean checkout", setup.ok, setup.ok ? undefined : failure("setup", setup));
  if (!setup.ok) return;

  const verify = await runDeclared(manifest.commands.verify, checkout, timeoutSeconds);
  add(
    "Verify passes on a clean checkout",
    verify.ok,
    verify.ok ? undefined : failure("verify", verify),
  );
  if (!verify.ok) return;

  const changed = git(checkout, "status", "--porcelain", "--untracked-files=no").stdout.trim();
  add(
    "Verify changes no tracked files",
    changed === "",
    changed ? `changed:\n${changed}` : undefined,
  );

  const existing = firstFile(join(checkout, manifest.acceptanceTests));
  if (!existing) {
    add(
      "Verify fails when a failing Acceptance test is planted",
      false,
      `no Acceptance test found under ${manifest.acceptanceTests}/ to plant beside`,
    );
    return;
  }
  // Named like an existing test so the Repo's runner picks it up, whatever its stack;
  // content no runner can parse, so it fails whatever its framework.
  const planted = join(dirname(existing), `factory-planted-${basename(existing)}`);
  writeFileSync(planted, "Planted by the Factory's Contract check: this must fail. )]}>(\n");
  const withPlant = await runDeclared(manifest.commands.verify, checkout, timeoutSeconds);
  rmSync(planted);
  add(
    "Verify fails when a failing Acceptance test is planted",
    !withPlant.ok && !withPlant.timedOut,
    withPlant.ok
      ? `verify still passed with ${basename(planted)} planted, so it doesn't run every Acceptance test`
      : withPlant.timedOut
        ? `verify timed out after ${timeoutSeconds}s with the planted test`
        : undefined,
  );
}

type Protection = {
  required_pull_request_reviews?: unknown;
  required_status_checks?: { contexts?: string[]; checks?: unknown[] } | null;
  allow_force_pushes?: { enabled: boolean };
};
type CheckRuns = {
  total_count: number;
  check_runs: { name: string; status: string; conclusion: string | null }[];
};
type Statuses = { total_count: number; state: string };

async function checkGitHub(
  github: GitHub,
  slug: string,
  manifestBranch: string | undefined,
  add: (rule: string, ok: boolean, detail?: string) => void,
) {
  const repo = await github.get<{ default_branch: string; has_issues: boolean }>(`/repos/${slug}`);
  if (!repo) {
    add("GitHub remote", false, `${slug} not found (or no access)`);
    return;
  }
  add("GitHub remote", true, slug);

  const branch = manifestBranch ?? repo.default_branch;
  add(
    "Default branch matches the Repo manifest",
    repo.default_branch === branch,
    repo.default_branch === branch
      ? undefined
      : `GitHub's is ${repo.default_branch}, manifest says ${branch}`,
  );

  add(
    "GitHub Issues are enabled",
    repo.has_issues,
    repo.has_issues ? undefined : "Issues are turned off",
  );

  const labels = (await github.get<{ name: string }[]>(`/repos/${slug}/labels?per_page=100`)) ?? [];
  const names = new Set(labels.map((l) => l.name));
  const missingLabels = FACTORY_LABELS.map((l) => l.name).filter((n) => !names.has(n));
  add(
    "Factory labels exist",
    missingLabels.length === 0,
    missingLabels.length ? `missing: ${missingLabels.join(", ")}` : undefined,
  );

  const protection = await github.get<Protection>(`/repos/${slug}/branches/${branch}/protection`);
  const gaps: string[] = [];
  if (!protection) gaps.push("the branch is not protected");
  else {
    if (!protection.required_pull_request_reviews) gaps.push("pull requests are not required");
    const checks = protection.required_status_checks;
    if (!checks || ((checks.contexts?.length ?? 0) === 0 && (checks.checks?.length ?? 0) === 0)) {
      gaps.push("no status checks are required");
    }
    if (protection.allow_force_pushes?.enabled) gaps.push("force-pushes are allowed");
  }
  add(
    `${branch} is protected: PRs only, CI required, no force-pushes`,
    gaps.length === 0,
    gaps.length ? gaps.join("; ") : undefined,
  );

  const runs = await github.get<CheckRuns>(`/repos/${slug}/commits/${branch}/check-runs`);
  const statuses = await github.get<Statuses>(`/repos/${slug}/commits/${branch}/status`);
  const ciProblem = (() => {
    const all = runs?.check_runs ?? [];
    if (all.length === 0 && (statuses?.total_count ?? 0) === 0) return `no CI status on ${branch}`;
    const pending = all.filter((r) => r.status !== "completed").map((r) => r.name);
    if (pending.length) return `CI still running: ${pending.join(", ")}`;
    const failed = all
      .filter((r) => !["success", "neutral", "skipped"].includes(r.conclusion ?? ""))
      .map((r) => r.name);
    if (failed.length) return `CI failed: ${failed.join(", ")}`;
    if ((statuses?.total_count ?? 0) > 0 && statuses?.state !== "success") {
      return `commit status is ${statuses?.state}`;
    }
    return null;
  })();
  add(`CI passes on ${branch}`, ciProblem === null, ciProblem ?? undefined);
}
