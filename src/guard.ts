import { homedir } from "node:os";
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

const WORKFLOWS = ".github/workflows";

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
 * may change the Acceptance tests, no agent may change the Spec or the CI workflows, and
 * nobody may force-push.
 */
export function decide(input: HookInput, env: NodeJS.ProcessEnv = process.env): Decision {
  const tool = input.tool_name ?? "";
  const cwd = input.cwd ?? process.cwd();
  const isAcceptanceAgent =
    input.agent_type === ACCEPTANCE_AGENT || env.FACTORY_ROLE === ACCEPTANCE_AGENT;

  if (tool === "Bash") {
    const command = String(input.tool_input?.command ?? "");
    if (isForcePush(command)) return deny("Force-pushing is not allowed in a Factory Run.");
    return checkBash(command, cwd, isAcceptanceAgent);
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
    {
      // CI runs the PR's own workflows, so an agent editing them could make any check pass.
      rel: norm(WORKFLOWS),
      reason: `CI workflows (${WORKFLOWS}/) are read-only to agents; changing CI is the Operator's call.`,
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

/** One simple command: its source text, its words (quotes removed) and its redirect targets. */
type Segment = { text: string; words: string[]; targets: string[] };

/**
 * Splits a shell command into simple commands, respecting quotes, backslashes and heredoc
 * bodies (which are skipped). Good enough for a guard, not a full shell parser.
 */
function segments(command: string): Segment[] {
  const out: Segment[] = [];
  let text = "";
  let word = "";
  let inWord = false;
  let words: string[] = [];
  let targets: string[] = [];
  let nextIsTarget = false;
  let quote: string | null = null;
  const heredocs: { delimiter: string; tabs: boolean }[] = [];

  const endWord = () => {
    if (!inWord) return;
    (nextIsTarget ? targets : words).push(word);
    nextIsTarget = false;
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length || targets.length) out.push({ text: text.trim(), words, targets });
    text = "";
    words = [];
    targets = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      text += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      text += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
      text += c;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(command.slice(i));
      if (m) {
        endWord();
        heredocs.push({ delimiter: m[3] as string, tabs: m[1] === "-" });
        text += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\n") {
      endSegment();
      for (const h of heredocs) i = endOfHeredoc(command, i + 1, h.delimiter, h.tabs);
      heredocs.length = 0;
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      endSegment();
      continue;
    }
    if (c === ">") {
      endWord();
      text += c;
      if (command[i + 1] === ">") text += command[++i];
      if (command[i + 1] === "&") {
        // `2>&1` and the like duplicate a descriptor; they write no file.
        while (/[&\d-]/.test(command[i + 1] ?? "")) text += command[++i];
      } else nextIsTarget = true;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      text += c;
      continue;
    }
    word += c;
    inWord = true;
    text += c;
  }
  endSegment();
  return out;
}

/** Index of the newline ending a heredoc body's delimiter line (or the end of the command). */
function endOfHeredoc(command: string, from: number, delimiter: string, tabs: boolean): number {
  let start = from;
  while (start < command.length) {
    const nl = command.indexOf("\n", start);
    const end = nl === -1 ? command.length : nl;
    const line = command.slice(start, end);
    if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) return end;
    start = end + 1;
  }
  return command.length;
}

export function isForcePush(command: string): boolean {
  return segments(command).some(({ words: t }) => {
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
// `commit` and `add` record changes already made (and already guarded); they change no files.
const GIT_READERS = new Set("log diff show status blame ls-files grep commit add".split(" "));

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

/**
 * Commands that can wipe a protected path by naming a directory above it (`rm -rf .`,
 * `git checkout main -- .`). Commands that only drop untracked or uncommitted work
 * (`git clean`, `git reset`, `git stash`) are left out: builders can't create files in a
 * protected path, and committed Acceptance tests survive them.
 */
const GIT_WIPERS = new Set("checkout restore rm mv".split(" "));

function isWiper(t: string[]): boolean {
  const name = (t[0] ?? "").replace(/^.*\//, "");
  if (["rm", "rmdir", "mv", "shred", "truncate"].includes(name)) return true;
  if (name === "find") return !isReadOnly(t);
  return name === "git" && GIT_WIPERS.has(t.slice(1).find((a) => !a.startsWith("-")) ?? "");
}

/** A shell word as a native path: Git Bash's `/c/...` becomes `C:/...`, and `~` the home directory. */
function toNative(word: string): string {
  if (word === "~" || word.startsWith("~/")) return homedir() + word.slice(1);
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(word);
  if (process.platform === "win32" && msys) return `${msys[1]}:/${word.slice(3)}`;
  return word;
}

/** The path-like parts of a word: the word itself (minus any glob) and whatever follows `=`. */
function pathParts(word: string): string[] {
  const parts = word.startsWith("-") ? [] : [word];
  const eq = word.indexOf("=");
  if (eq !== -1) parts.push(word.slice(eq + 1));
  return parts.map((p) => p.replace(/[*?[].*$/, "") || ".");
}

/**
 * Checks each simple command against the Factory Repo its paths land in. Follows `cd`, so
 * a command can't escape by changing directory or by naming another Repo absolutely.
 */
function checkBash(command: string, startCwd: string, isAcceptanceAgent: boolean): Decision {
  const cache = new Map<string, ReturnType<typeof protectedFor>>();
  const protectedAt = (root: string) => {
    if (!cache.has(root)) cache.set(root, protectedFor(root, isAcceptanceAgent));
    return cache.get(root) as ReturnType<typeof protectedFor>;
  };
  /** The protected path an absolute path falls in (or, with `above`, sits above), or a denial. */
  const hitAt = (abs: string, above: boolean): Protected | Decision | undefined => {
    const root = findRepoRoot(abs);
    if (!root) return undefined;
    const p = protectedAt(root);
    if ("error" in p) return deny(p.error);
    const rel = norm(relative(root, abs));
    return p.paths.find((x) => within(rel, x.rel) || (above && (rel === "" || within(x.rel, rel))));
  };
  const blocked = (s: Segment, hit: Protected | Decision) =>
    "allow" in hit ? hit : deny(`${hit.reason} (Bash command touching it: \`${s.text}\`)`);

  let cwd = startCwd;
  for (const s of segments(command)) {
    if (s.words[0] === "cd") {
      cwd = resolve(cwd, toNative(s.words[1] ?? homedir()));
      continue;
    }
    // Working inside a protected directory, any command that isn't read-only may touch it.
    const here = hitAt(cwd, false);
    for (const t of s.targets) {
      const hit = here ?? hitAt(resolve(cwd, toNative(t)), false);
      if (hit) return blocked(s, hit);
    }
    if (isReadOnly(s.words)) continue;
    if (here) return blocked(s, here);
    const above = isWiper(s.words);
    for (const word of s.words.slice(1)) {
      for (const part of pathParts(word)) {
        const hit = hitAt(resolve(cwd, toNative(part)), above);
        if (hit) return blocked(s, hit);
      }
    }
  }
  return allow;
}
