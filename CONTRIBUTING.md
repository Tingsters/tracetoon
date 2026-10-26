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
| `src/workflow/` | Worktree-local task lifecycle, exact-content validation receipts, host-session registry and publication recovery |
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
- `bun run test:bundled` exercises the shipped bundle; `bun run build` followed
  by `bun run test:compiled` rehearses publication against the native executable.
- Never commit real session logs. Fixtures are synthetic or scrubbed.

Contributor research and review handoffs live in `src/contribution/`; their host
agent role prompts and v1 contracts are documented in the packaged skill's
`references/contribution-workflow.md`. Run `bun scripts/eval-contributions.ts
prepare`, supply separate baseline and three-phase drafts, then run
`review-inputs` and `score` to exercise the synthetic, source-cited evaluation.
Its lexical probes are smoke checks, not a semantic quality score. Evaluation
artifacts stay under `.git/tracetoon/eval-contributions/`.

For visual comic changes, `bun scripts/eval-comics.ts prepare` allocates paired
baseline/candidate runs for six synthetic scenarios and two held-out cases
(cache invalidation and documentation only). Existing flawed originals remain
negative controls. Have a drafter write candidates from each scenario.json;
draw and render explicitly through an approved image route. Preparation never
requests images, moves the latest task, or overwrites candidate scripts.
Run `bun scripts/eval-comics.ts blind` for image-only review, then `gallery` to
compare with facts, reader probes and schematic geometry proofs at PR/phone
widths. Optional scenario ids after any command select a subset. Record actual
observations, inference, payoff and factual fidelity separately; structural
tests and reader probes are not automated humor scores. Artifacts stay in .git/.

## Releasing

Bump only `package.json`, then run `bun run bundle`. The build stamps the skill
VERSION, plugin version and shared build identity; `bun run build:check` detects
drift. Commit the generated files, then push a matching `vX.Y.Z` tag after review.
The release workflow rebuilds the bundle, verifies versions and builds binaries
and skill zips from that same identity. Never publish a source-only update as
though it updated installed runtimes. `tracetoon doctor --json` reports actual
runtime and hook identities, installed skill mismatches and observed hook events.
