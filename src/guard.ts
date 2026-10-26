import { dirname, isAbsolute, relative, resolve } from "node:path";
import { findRepoRoot, readManifest, SPEC } from "./repo.ts";

/** The parts of Claude Code's PreToolUse hook input the guard reads. */
export type HookInput = {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  /** Set by Claude Code inside a subagent: the subagent's frontmatter `name`. */
  agent_type?: string;
};

export type Decision = { allow: true } | { allow: false; reason: string };

/** The subagent allowed to write Acceptance tests. */
export const ACCEPTANCE_AGENT = "acceptance";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const caseInsensitive = process.platform === "win32";
const norm = (p: string) => {
  const s = p.replace(/\\/g, "/");
  return caseInsensitive ? s.toLowerCase() : s;
};

const allow: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

/**
 * Decides whether a tool call may run. In a Factory Repo, only the Acceptance subagent
 * may change the Acceptance tests, nobody may change the Spec, and nobody may force-push.
 */
export function decide(input: HookInput, env: NodeJS.ProcessEnv = process.env): Decision {
  const tool = input.tool_name ?? "";
  const cwd = input.cwd ?? process.cwd();
  const isAcceptanceAgent =
    input.agent_type === ACCEPTANCE_AGENT || env.FACTORY_ROLE === ACCEPTANCE_AGENT;

  if (tool === "Bash") {
    const command = String(input.tool_input?.command ?? "");
    if (isForcePush(command)) return deny("Force-pushing is not allowed in a Factory Run.");
    const root = findRepoRoot(cwd);
    if (!root) return allow;
    const protectedPaths = protectedFor(root, isAcceptanceAgent);
    if ("error" in protectedPaths) return deny(protectedPaths.error);
    return checkBash(command, root, cwd, protectedPaths.paths);
  }

  if (EDIT_TOOLS.has(tool)) {
    const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof raw !== "string" || raw === "") return allow;
    const target = isAbsolute(raw) ? raw : resolve(cwd, raw);
    const root = findRepoRoot(dirname(target));
    if (!root) return allow;
    const protectedPaths = protectedFor(root, isAcceptanceAgent);
    if ("error" in protectedPaths) return deny(protectedPaths.error);
    const hit = protectedPaths.paths.find((p) => within(norm(relative(root, target)), p.rel));
    if (hit) return deny(hit.reason);
  }

  return allow;
}

type Protected = { rel: string; reason: string };

const within = (rel: string, protectedRel: string) =>
  rel === protectedRel || rel.startsWith(`${protectedRel}/`);

function protectedFor(
  root: string,
  isAcceptanceAgent: boolean,
): { paths: Protected[] } | { error: string } {
  let acceptanceTests: string;
  try {
    acceptanceTests = readManifest(root).acceptanceTests;
  } catch (e) {
    return {
      error: `The Repo manifest is unusable, so the guard blocks this: ${(e as Error).message}`,
    };
  }
  const paths: Protected[] = [
    {
      rel: norm(SPEC),
      reason: "The Spec (.factory/spec.md) is read-only; changing it is the Operator's call.",
    },
  ];
  if (!isAcceptanceAgent) {
    paths.push({
      rel: norm(acceptanceTests),
      reason: `Acceptance tests (${acceptanceTests}/) are read-only to you. If one looks wrong or impossible, raise an Acceptance dispute in the PR instead.`,
    });
  }
  return { paths };
}

/** Splits a shell command into simple-command segments (good enough for a guard, not a parser). */
function segments(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\||&/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const tokens = (segment: string) => segment.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ""));

export function isForcePush(command: string): boolean {
  return segments(command).some((segment) => {
    const t = tokens(segment);
    const git = t.indexOf("git");
    if (git === -1) return false;
    const push = t.indexOf("push", git + 1);
    if (push === -1) return false;
    return t
      .slice(push + 1)
      .some(
        (arg) =>
          /^--force(-with-lease(=.*)?|-if-includes)?$/.test(arg) ||
          /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg) ||
          (arg.startsWith("+") && arg.length > 1),
      );
  });
}

/** Commands that may name a protected path because they only read it (or run the tests). */
const READERS = new Set(
  "cat less more head tail grep egrep rg ls wc diff file stat echo printf".split(" "),
);
const GIT_READERS = new Set("log diff show status blame ls-files grep".split(" "));

function isReadOnly(t: string[]): boolean {
  const name = (t[0] ?? "").replace(/^.*\//, "");
  if (READERS.has(name)) return true;
  if (name === "find") {
    return !t.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(a));
  }
  if (name === "git") return GIT_READERS.has(t.slice(1).find((a) => !a.startsWith("-")) ?? "");
  if (name === "playwright") return t[1] === "test";
  if (["pnpm", "npx", "npm", "yarn"].includes(name)) {
    const [a = "", b = "", c = ""] = t.slice(1).filter((x) => !x.startsWith("-"));
    if (a === "playwright" && b === "test") return true;
    if ((a === "exec" || a === "x") && b === "playwright" && c === "test") return true;
    return a === "acceptance" || (a === "run" && b === "acceptance");
  }
  return name === "factory";
}

function checkBash(command: string, root: string, cwd: string, paths: Protected[]): Decision {
  const relCwd = norm(relative(root, cwd));
  const absRoot = norm(root);
  // Working inside a protected directory, any command may touch it.
  const cwdHit = paths.find((p) => within(relCwd, p.rel));
  for (const segment of segments(command)) {
    const hit = cwdHit ?? paths.find((p) => mentions(norm(segment), p.rel, relCwd, absRoot));
    if (!hit) continue;
    if (/>/.test(segment) || !isReadOnly(tokens(segment))) {
      return deny(`${hit.reason} (Bash command touching it: \`${segment}\`)`);
    }
  }
  return allow;
}

/** Whether a normalised command segment names a protected path: from the root, the cwd, or absolutely. */
function mentions(segment: string, rel: string, relCwd: string, absRoot: string): boolean {
  const forms = new Set([rel, `${absRoot}/${rel}`]);
  if (relCwd && relCwd !== "." && rel.startsWith(`${relCwd}/`)) {
    forms.add(rel.slice(relCwd.length + 1));
  }
  const escapeRegExp = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...forms].some((f) =>
    new RegExp(`(^|[\\s'"=:(])(\\./)?${escapeRegExp(f)}(/|$|[\\s'")])`).test(segment),
  );
}
