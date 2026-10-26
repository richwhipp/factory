import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide, type HookInput } from "./guard.ts";
import { defaultClaudeDir, install } from "./install.ts";

const USAGE = `Usage: factory <command>

Commands:
  guard     PreToolUse hook: reads hook JSON on stdin, denies protected edits and force-pushes
  install   Register the Factory's hooks in user-level Claude Code settings
            [--claude-dir <dir>]  (default: $CLAUDE_CONFIG_DIR or ~/.claude)
`;

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

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "guard":
      return guard();
    case "install": {
      const i = rest.indexOf("--claude-dir");
      const claudeDir = i === -1 ? defaultClaudeDir() : (rest[i + 1] ?? defaultClaudeDir());
      const file = install(claudeDir, fileURLToPath(import.meta.url));
      console.log(`Factory hooks registered in ${file}`);
      return 0;
    }
    default:
      process.stderr.write(USAGE);
      return command ? 1 : 0;
  }
}

process.exitCode = main(process.argv.slice(2));
