# factory

The `factory` CLI for the AI Software Factory, installed at user level so a Repo can't weaken it.

```sh
scripts/install.sh   # build, then register the hooks in ~/.claude/settings.json
```

## Commands

- `factory guard`: Claude Code PreToolUse hook. In a Repo with a Repo manifest, it denies every agent except the Acceptance subagent any change to the Acceptance tests path, denies everyone any change to `.factory/spec.md`, and denies force-pushes everywhere.
- `factory install [--claude-dir <dir>]`: registers the hooks (default `$CLAUDE_CONFIG_DIR` or `~/.claude`). Running it again replaces the Factory's entry.

## Cloud sessions

Paste `scripts/cloud-setup.sh` into the Factory's Claude Code on the web environment as its setup script.
