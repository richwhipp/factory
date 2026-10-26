# CLAUDE.md

The AI Software Factory's tooling: the `factory` CLI (the deterministic core the Factory's skills, hooks, Routines and Actions workflows call) and its user-level install. Planning, glossary and ADRs live in `richwhipp/ai-software-factory`; use its `CONTEXT.md` terms (Repo, Repo manifest, Acceptance tests, Spec, Ticket, Run …).

## Layout

- `src/cli.ts`: entry point; dispatches subcommands.
- `src/guard.ts`: `factory guard`, the PreToolUse hook.
- `src/repo.ts`: finds a Repo by its Repo manifest (`.factory/repo.yml`) and reads it.
- `src/install.ts`: `factory install`, which registers the hooks in user-level Claude Code settings.
- `build.mjs`: bundles everything into `dist/factory.mjs`, a single file that needs no `node_modules` at runtime.
- `test/`: black-box tests. `test/run.ts` runs the built bundle as a separate process and builds fixture Repos on disk.
- `scripts/install.sh`: the one install step (build, then register hooks). `scripts/cloud-setup.sh`: the cloud environment's setup script.

## Commands

| Command              | What it does                                   |
| -------------------- | ---------------------------------------------- |
| `pnpm run build`     | Bundle the CLI into `dist/factory.mjs`         |
| `pnpm run test`      | Build, then run the black-box tests            |
| `pnpm run verify`    | `tsc --noEmit` → `biome check` → build → tests |
| `pnpm run format`    | Biome fixes and formats files (writes)         |
| `scripts/install.sh` | Install the Factory at user level              |

## Rules

- Test the CLI only from outside: run the built bundle with arguments, stdin and environment, and assert on exit code, output and the files or GitHub state it leaves. Never import `src/` from tests.
- The pipeline never assumes a stack: read what a Repo declares in its Repo manifest, never hard-code paths such as `acceptance/`.
- The guard fails closed: if it can't read its input or the Repo manifest, it denies.
- Keep runtime dependencies few; everything is bundled.

## Gotchas

- Hook commands run under Git Bash on Windows, so the installed command is `node "<path>/dist/factory.mjs" guard` with forward slashes.
- Inside a subagent, hook input carries `agent_type` (the subagent's frontmatter `name`). The guard trusts `agent_type: "acceptance"`, or `FACTORY_ROLE=acceptance` for an Acceptance run in its own session.
- The Operator's Windows machine blocks executables in AppData: no native addons, and never nest `pnpm run` inside package scripts.
