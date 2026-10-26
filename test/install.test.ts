import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factory } from "./run.ts";

const settingsIn = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

describe("install", () => {
  it("registers the guard as a PreToolUse hook in user-level settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-"));
    expect(factory(["install", "--claude-dir", dir]).status).toBe(0);

    const [entry] = settingsIn(dir).hooks.PreToolUse;
    expect(entry.matcher).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
    expect(entry.hooks[0].command).toMatch(/^node ".*factory.*" guard$/);
  });

  it("keeps existing settings and hooks, and doesn't duplicate itself when run again", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-"));
    const other = { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] };
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "opus", hooks: { PreToolUse: [other] } }),
    );

    factory(["install", "--claude-dir", dir]);
    factory(["install", "--claude-dir", dir]);

    const settings = settingsIn(dir);
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0]).toEqual(other);
  });
});
