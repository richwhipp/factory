# factory

The `factory` CLI for the AI Software Factory, installed at user level so a Repo can't weaken it.

```sh
scripts/install.sh   # build, then register the hooks in ~/.claude/settings.json
```

## Commands

- `factory guard`: Claude Code PreToolUse hook. In a Repo with a Repo manifest, it denies every agent except the Acceptance subagent any change to the Acceptance tests path, denies every agent any change to `.factory/spec.md` or `.github/workflows/`, and denies force-pushes everywhere.
- `factory order-check [--base <ref>]`: CI check for a Ticket branch. Its leading Acceptance commits may touch only the Acceptance tests path; no later commit may touch that path or `.factory/spec.md`. Exits 1 with each offending commit and path.
- `factory contract-check [--repo <owner/name>] [--timeout <seconds>]`: does this Repo meet Repo contract v1? It validates the committed Repo manifest and runs Setup and Verify on a clean checkout of HEAD. It checks that Verify changes no tracked files and fails when a broken Acceptance test is planted beside an existing one. Through GitHub's REST API, it checks Issues, the Factory labels, branch protection and CI on the default branch. Exits 1 with each failing rule. GitHub token: `FACTORY_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`; `FACTORY_GITHUB_API` overrides the API URL.
- `factory install [--claude-dir <dir>]`: registers the hooks (default `$CLAUDE_CONFIG_DIR` or `~/.claude`). Running it again replaces the Factory's entry.

## Cloud sessions

Paste `scripts/cloud-setup.sh` into the Factory's Claude Code on the web environment as its setup script.

## Releases

Pushing a tag `vX.Y.Z` publishes `factory.mjs` (and its `.sha256`) as a GitHub release. A Repo's CI downloads a pinned version and checks its SHA-256 before running it, for example `factory.mjs order-check`.
