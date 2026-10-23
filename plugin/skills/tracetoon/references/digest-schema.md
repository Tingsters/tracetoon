# digest.json fields

| Field | Meaning |
|---|---|
| `pr` | Base, head, merge base, commits (short SHA, subject, trailers), existing PR number and URL |
| `pr.usedWorkingTree` | True when there are no commits yet and the digest describes uncommitted changes |
| `stats.agentMatchedPct` | Share of non-trivial added lines that match an agent edit |
| `stats.commitsMadeInSessions` / `stats.commits` | Commits whose SHA appeared in an agent session's command output |
| `sessions[].ref` | Stable hashed id; use it with `--include`, `--exclude`, `expand` |
| `sessions[].band` | `included`, or `ambiguous` (ask the user) |
| `sessions[].score`, `reasons` | Why the session was matched |
| `sessions[].prompts` | What the user typed (redacted, clipped); `ledToEdits` = the turn produced lines that are in the PR |
| `sessions[].delegations` | Tasks the agent gave its own subagents (not the user's words) |
| `sessions[].plans` | Plan excerpts and whether the user approved them (Codex plans have no approval step) |
| `sessions[].artifacts` | Documents the agent kept (Antigravity task, implementation plan, walkthrough), with its own summary |
| `sessions[].decisions` | Questions the agent asked and the answers |
| `sessions[].commands` | Grouped shell commands with counts, failures, and an `isTest` flag |
| `sessions[].milestones` | Deterministic events: plan approved, tests went from failing to passing, edits that didn't survive |
| `sessions[].usage`, `sessionCostUsd` | Token totals for the matched part; cost is for the whole session |
| `files[]` | Per file: lines added/removed, lines matched to each session, unmatched lines |
| `disclosure` | Agents, models, suggested and existing AI trailers |
| `interop` | Provenance other tools recorded: Entire checkpoints in commit trailers, git-ai notes |
| `privacy` | Redaction count and records dropped because they belonged to other repos |
| `notes` | Things to tell the user or reflect in the text |
| `truncated` | What was trimmed to fit the budget; use `tracetoon expand <ref>` for full detail |
