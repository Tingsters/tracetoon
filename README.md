# Tracetoon

**PR descriptions that show how the change was made.** Tracetoon reads the
session logs your AI coding agents already keep on your machine, finds the
sessions that produced your branch, and helps your agent write a PR description
that covers the plan, the decisions, what was tested, and how much was
AI-assisted. You see the exact text and approve it before anything is posted.

(The 4-panel comic summary is coming in a later release.)

- **Install after the fact.** Write your code first, with any supported agent.
  Then add Tracetoon. It reads logs that already exist: no hooks, no background
  capture, no history database.
- **Preview first.** Posting requires an approval code tied to the exact text
  you previewed. An optional yolo mode skips the preview only when every safety
  check passes.
- **Private by default.** Only records from this repository are used. Secrets,
  personal data, your home path and username are redacted, and a second scanner
  checks the final text before it can be posted.

| Agent | Status |
|---|---|
| Claude Code | supported |
| Codex | coming in 0.2 |
| Antigravity (CLI and IDE) | coming in 0.2 |

## Use it

### Claude Code

```text
/plugin marketplace add Tingsters/tracetoon
/plugin install tracetoon@tracetoon
```

Then ask: *"Open a PR for this branch with Tracetoon."*

### Codex, Antigravity, Gemini CLI and other Agent Skills hosts

Copy `plugin/skills/tracetoon/` to your agent's skills folder:

| Agent | Folder |
|---|---|
| Codex | `~/.agents/skills/tracetoon` (or `.agents/skills/` in a repo) |
| Antigravity | `~/.gemini/antigravity/skills/tracetoon` |
| Gemini CLI | `~/.gemini/skills/tracetoon` |

## How it works

1. `tracetoon digest` reads the branch from git (base, commits, the exact lines
   added), finds agent sessions that touched this repository, and scores them.
   The evidence: edits whose lines are still in the diff, commits made during
   the session, a PR link, the branch, timing and working folder. It writes a
   redacted digest sized for an LLM.
2. `tracetoon context` reads the PR template, any AI-contribution policy, the
   existing PR, and your settings.
3. Your agent writes `body.md` from the digest.
4. `tracetoon render` builds the final body (Tracetoon only owns a marked
   region; your own text in an existing PR is kept), scans it for leaks and
   prints an approval code.
5. `tracetoon publish --code <code>` creates or updates the PR with `gh`.

Run files live in `.git/tracetoon/runs/`, which git never tracks.

## Running it

The skill ships a small launcher (`bin/tracetoon`, `bin/tracetoon.cmd`). It uses,
in order: a prebuilt binary if one is cached, Bun, or Node 22+ with the bundled
`dist/tracetoon.mjs`. With your permission it can instead download the release
binary with `gh` and verify its checksum.

## Settings

`tracetoon config set <key> <value>`, or per repo in `.github/tracetoon.json`:

| Key | Default | Meaning |
|---|---|---|
| `yolo` | `false` | Allow `publish --yolo` to skip the preview when all checks pass |
| `promptQuoting` | `paraphrase` | `verbatim` quotes your prompts in the PR |
| `disclosure` | `assisted-by` | Trailer style to suggest |
| `theme` | `pets` | Comic theme (`pets`, `mecha`, `scifi`), for the coming comic feature |
| `budgetTokens` | `12000` | Digest size |

## Develop

```sh
bun install
bun test
bun run typecheck
bun run bundle      # rebuilds plugin/skills/tracetoon/dist/tracetoon.mjs
```

Tracetoon builds on [`@showtail/agent-traces`](https://github.com/Tingsters/Showtail/tree/main/packages/agent-traces),
the log readers and redaction shared with [Showtail](https://github.com/Tingsters/Showtail).
Until that package is on npm, development expects a Showtail checkout next to
this repo (see `tsconfig.json` paths).

Apache-2.0.
