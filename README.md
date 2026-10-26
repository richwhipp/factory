# factory

The `factory` CLI for the AI Software Factory, installed at user level so a Repo can't weaken it.

```sh
scripts/install.sh   # build, then register the hooks in ~/.claude/settings.json
```

## Commands

- `factory guard`: Claude Code PreToolUse hook. In a Repo with a Repo manifest, it denies every agent except the Acceptance subagent any change to the Acceptance tests path, denies every agent any change to `.factory/spec.md` or `.github/workflows/`, and denies force-pushes everywhere.
- `factory order-check [--base <ref>]`: CI check for a Ticket branch. Its leading Acceptance commits may touch only the Acceptance tests path; no later commit may touch that path or `.factory/spec.md`. Exits 1 with each offending commit and path.
- `factory install [--claude-dir <dir>]`: registers the hooks (default `$CLAUDE_CONFIG_DIR` or `~/.claude`). Running it again replaces the Factory's entry.

## Cloud sessions

Paste `scripts/cloud-setup.sh` into the Factory's Claude Code on the web environment as its setup script.

## Releases

Pushing a tag `vX.Y.Z` publishes `factory.mjs` (and its `.sha256`) as a GitHub release. A Repo's CI downloads a pinned version and checks its SHA-256 before running it, for example `factory.mjs order-check`.
