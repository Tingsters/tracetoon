# digest.json fields

Prompts, decisions, plans and runs carry short ids (`S1`, `D1`, `P1`, `R1`) so
you can keep track of which fact supports which sentence. Don't print the ids in
the PR.

| Field | Meaning |
|---|---|
| `pr` | Base, head, merge base, commits (short SHA, subject, trailers, commit time), existing PR number and URL |
| `pr.usedWorkingTree` | True when there are no commits yet and the digest describes uncommitted changes |
| `pr.dirty` | Uncommitted changes existed: a run may have tested code that isn't in the PR |
| `stats.agentMatchedPct` | Share of non-trivial added lines that match a captured agent edit |
| `stats.commitsMadeInSessions` / `stats.commits` | Commits a session made (printed by its git commands, or its message in a `git commit`) |
| `sessions[].ref` | Stable hashed id; use it with `--include`, `--exclude`, `expand` |
| `sessions[].band` | `included`, or `ambiguous` (ask the user) |
| `sessions[].score`, `reasons` | Why the session was matched |
| `sessions[].prompts` | What the user typed (redacted, clipped). `ledToEdits`: the turn produced lines that are in the PR. `pushback`: typed while rejecting the agent's action, so it corrects or steers it |
| `sessions[].delegations` | Tasks the agent gave its own subagents (not the user's words) |
| `sessions[].plans` | Plan excerpts. `approved: false` means sent back, which doesn't by itself mean the design was rejected (Codex plans have no approval step) |
| `sessions[].artifacts` | Documents the agent kept (Antigravity task, implementation plan, walkthrough), with its own summary |
| `sessions[].decisions` | Questions the agent asked and the answers. `questions[]` (when recorded) has each question's `options` and the exact `answer`; `ownWords` means the user answered in their own words instead of picking an option. An option that wasn't picked is only that: not picked |
| `sessions[].runs` | Individual verification runs: `kind` (test, build, lint, typecheck, eval), `outcome` (passed, failed, unknown), `basis` (exit status, output, none), up to three result lines in `summary`, and `revision`: `before later edits` (PR files changed after it), `no later edits seen`, or `unknown`. A run never proves the final revision passes; word it as what ran and what it showed |
| `sessions[].commands` | Grouped shell commands with counts, failures, and an `isTest` flag |
| `sessions[].milestones` | Deterministic events: plan approved, tests went from failing to passing, edits that didn't survive |
| `sessions[].usage`, `sessionCostUsd` | Token totals for the matched part; cost is for the whole session |
| `files[]` | Per file: `role` (behavior, tests, docs, config, generated, version), lines added/removed, lines matched to each session, lines not matched to captured evidence |
| `disclosure` | Agents, models, suggested and existing AI trailers |
| `interop` | Provenance other tools recorded: Entire checkpoints in commit trailers, git-ai notes |
| `privacy` | Redaction count and records dropped because they belonged to other repos |
| `linkedPrs` | Other PRs the sessions linked themselves to (feeds saga detection) |
| `notes` | Things to tell the user or reflect in the text |
| `truncated` | What was trimmed to fit the budget; use `tracetoon expand <ref>` for full detail |
