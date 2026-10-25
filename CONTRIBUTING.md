# Contributing

## Setup

```sh
git clone https://github.com/Tingsters/Showtail ../Showtail
git clone https://github.com/Tingsters/tracetoon && cd tracetoon
bun install
bun test
```

## Layout

| Path | What lives there |
|---|---|
| `src/trace/` | One adapter per agent (Claude Code, Codex, Antigravity). Each turns raw logs into normalized `TraceRecord`s and keeps each record's own cwd and branch. |
| `src/git/` | What the PR is (base, commits, added lines), interop with Entire and git-ai |
| `src/correlate/` | Which sessions and records belong to this PR, and line attribution |
| `src/digest/` | The redacted, budgeted digest the agent writes from |
| `src/comic/` | Script format, style ideas, bubbles, rasterizing, image providers |
| `src/github/` | PR body region and metadata, assets branch, repo templates and policy |
| `src/hook/` | The agent PR hook (`hook pre-pr`), its install/uninstall into each agent's config, and the on/off switches |
| `src/commands/` | The CLI commands |
| `plugin/skills/tracetoon/` | The Agent Skills folder that ships: SKILL.md, references, launchers, bundle, assets |

## Adding an agent

1. Look at real logs and write down the record shapes (names and types only).
2. Add `src/trace/<agent>.ts` implementing `TraceAdapter`: `home`, `count`,
   `discover` (cheap relevance check), `read` (full parse). Count unrecognized
   record types in `unknownTypes`, so `doctor --probe` can spot format drift.
3. Register it in `src/trace/registry.ts`, add parser tests in
   `tests/adapters.test.ts` and an end-to-end test in `tests/flow.test.ts` with an
   isolated home directory.

## Before sending a change

- `bun run typecheck && bun test`
- `bun run bundle` and commit `plugin/skills/tracetoon/dist/tracetoon.mjs`
- Never commit real session logs. Fixtures are synthetic or scrubbed.

Contributor research and review handoffs live in `src/contribution/`; their host
agent role prompts and v1 contracts are documented in the packaged skill's
`references/contribution-workflow.md`. Run `bun scripts/eval-contributions.ts
prepare`, supply separate baseline and three-phase drafts, then run
`review-inputs` and `score` to exercise the synthetic, source-cited evaluation.
Its lexical probes are smoke checks, not a semantic quality score. Evaluation
artifacts stay under `.git/tracetoon/eval-contributions/`.

For visual comic changes, `bun scripts/eval-comics.ts prepare` creates six
synthetic PR scenarios. Draw and render each printed run through the normal
approved image route, then run `bun scripts/eval-comics.ts gallery` for a local
gallery at PR-column and phone widths, with schematic overlay geometry proofs.
Inspect actual hierarchy, lettering, story fidelity and payoff; passing prompt
tests is not a visual quality result. Gallery artifacts stay under `.git/`.

## Releasing

Bump the version in `package.json`, `src/version.ts`,
`plugin/.claude-plugin/plugin.json` and `plugin/skills/tracetoon/VERSION`, then
push a tag `vX.Y.Z`. The release workflow builds binaries and skill zips.
