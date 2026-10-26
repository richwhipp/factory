import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GUARD_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit";

type HookEntry = { matcher?: string; hooks?: { type: string; command?: string }[] };
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>;

export function defaultClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * Registers the Factory's hooks in the user-level Claude Code settings, keeping every
 * other setting. Running it again replaces the Factory's entry rather than adding one.
 */
export function install(claudeDir: string, cliPath: string): string {
  mkdirSync(claudeDir, { recursive: true });
  const file = join(claudeDir, "settings.json");
  const settings: Settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

  const command = `node "${cliPath.replace(/\\/g, "/")}" guard`;
  const isFactoryGuard = (e: HookEntry) =>
    e.hooks?.some((h) => /factory[^"]*" guard$/.test(h.command ?? "")) ?? false;

  settings.hooks ??= {};
  const preToolUse = (settings.hooks.PreToolUse ?? []).filter((e) => !isFactoryGuard(e));
  preToolUse.push({ matcher: GUARD_MATCHER, hooks: [{ type: "command", command }] });
  settings.hooks.PreToolUse = preToolUse;

  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}
