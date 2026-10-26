import { spawn, spawnSync } from "node:child_process";

export type CommandResult = {
  ok: boolean;
  status: number | null;
  timedOut: boolean;
  output: string;
};

/**
 * Runs a command a Repo declares, the way the pipeline always runs them: through a POSIX
 * shell (Git Bash on Windows), with no stdin, so anything that prompts fails or times out.
 * On timeout the whole process tree is killed, not just the shell.
 */
export function runDeclared(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  const shell = env.FACTORY_SHELL ?? (process.platform === "win32" ? "bash" : "/bin/sh");
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", command], {
      cwd,
      env: { ...env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group on POSIX, so a timeout can kill everything it started.
      detached: process.platform !== "win32",
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d;
    });
    child.stderr.on("data", (d) => {
      output += d;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutSeconds * 1000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ ok: status === 0 && !timedOut, status, timedOut, output });
    });
  });
}

function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The last lines of a command's output, for a failure report. */
export function tail(output: string, lines = 15): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}
