import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractCheck } from "./contract-check.ts";
import { GitHub } from "./github.ts";
import { decide, type HookInput } from "./guard.ts";
import { defaultClaudeDir, install } from "./install.ts";
import { type OrderResult, orderCheck } from "./order-check.ts";
import { findRepoRoot, MANIFEST } from "./repo.ts";

const USAGE = `Usage: factory <command>

Commands:
  guard     PreToolUse hook: reads hook JSON on stdin, denies protected edits and force-pushes
  install   Register the Factory's hooks in user-level Claude Code settings
            [--claude-dir <dir>]  (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  order-check
            CI check for the current branch: Acceptance commits first, then nothing touches
            the Acceptance tests or the Spec. Exit 1 on a violation.
            [--base <ref>]  (default: origin/<default_branch>, else <default_branch>)
  contract-check
            Does this Repo meet the Repo contract? Runs Setup and Verify on a clean
            checkout of HEAD and checks GitHub. Exit 1 if any rule fails.
            [--repo <owner/name>]  (default: from the origin remote)
            [--timeout <seconds>]  per declared command (default 1800)
`;

const option = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

function runOrderCheck(args: string[]): number {
  const root = findRepoRoot(process.cwd());
  if (!root) {
    process.stderr.write(`order-check: no Repo manifest (${MANIFEST}) here or above\n`);
    return 2;
  }
  let result: OrderResult;
  try {
    result = orderCheck(root, option(args, "--base"));
  } catch (e) {
    process.stderr.write(`order-check: ${(e as Error).message}\n`);
    return 2;
  }
  const { base, acceptanceCommits, laterCommits, violations } = result;
  const summary = `${acceptanceCommits} Acceptance commit(s), then ${laterCommits} other(s), since ${base.slice(0, 7)}`;
  if (violations.length === 0) {
    console.log(`order-check: ok (${summary})`);
    return 0;
  }
  console.log(`order-check: failed (${summary})`);
  for (const v of violations) console.log(`  ${v.sha} "${v.subject}" touches ${v.path}: ${v.rule}`);
  return 1;
}

async function runContractCheck(args: string[]): Promise<number> {
  // The git root, not the manifest: a Repo without a manifest is what this check reports.
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) {
    process.stderr.write("contract-check: not inside a git repository\n");
    return 2;
  }
  const result = await contractCheck(top.stdout.trim(), {
    github: GitHub.fromEnv(),
    timeoutSeconds: Number(option(args, "--timeout") ?? 1800),
    slug: option(args, "--repo"),
  });
  const version = JSON.stringify(result.contractVersion);
  console.log(
    `contract-check: ${result.slug ?? "(no GitHub remote)"}, contract_version ${version}`,
  );
  for (const r of result.rules) {
    const detail = r.detail ? `: ${r.detail.replace(/\n/g, "\n        ")}` : "";
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.rule}${detail}`);
  }
  const failed = result.rules.filter((r) => !r.ok).length;
  console.log(
    failed
      ? `contract-check: failed (${failed} of ${result.rules.length} rules)`
      : "contract-check: ok",
  );
  return failed ? 1 : 0;
}

function guard(): number {
  let input: HookInput;
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  } catch {
    printDeny("The Factory guard could not read its hook input, so it blocks this call.");
    return 0;
  }
  const decision = decide(input);
  if (!decision.allow) printDeny(decision.reason);
  return 0;
}

function printDeny(reason: string) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "guard":
      return guard();
    case "order-check":
      return runOrderCheck(rest);
    case "contract-check":
      return runContractCheck(rest);
    case "install": {
      const claudeDir = option(rest, "--claude-dir") ?? defaultClaudeDir();
      const file = install(claudeDir, fileURLToPath(import.meta.url));
      console.log(`Factory hooks registered in ${file}`);
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      return command ? 1 : 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
