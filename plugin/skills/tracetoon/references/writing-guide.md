# Writing the PR description

Write `body.md` for a reviewer who wasn't there. They want to know what changed
and why, how it was built, how it was checked, and how much was AI-assisted.

## If the repo has a PR template

Fill in the template's sections, in its order. Put the agent material in the
template's closest section, or add the sections below after it.

## Default structure

```markdown
## Summary
What changed and why, in 2–4 sentences. Take the "why" from the user's prompts.

## How it was built
The process, from the digest: the plan (and whether it was approved), an
Antigravity walkthrough if there is one (`artifacts`), key
decisions the user made, approaches that were tried and dropped
(`discardedEdits`, milestones), and how the agent verified the work.

## Changes
Grouped by area, not one bullet per file. Mention the files that matter.

## Testing
What was run (`commands` with `isTest`), and whether tests went from failing to
passing. Say plainly if nothing was tested.

## AI assistance
- Agents and models: from `disclosure`.
- How much: `stats.agentMatchedPct`% of added lines match agent edits;
  `stats.commitsMadeInSessions` of `stats.commits` commits were made during
  agent sessions.
- Suggested trailer: one line from `disclosure.suggestedTrailers`.
- If `interop.entire` is present, say the full checkpoints are available in
  Entire; if `interop.gitAi` is present, mention the git-ai notes.

<details>
<summary>Agent trace</summary>

A short timeline per session: the user's prompts (see "Quoting" below), plans,
decisions and milestones. Note token usage or cost if the digest has it.

</details>
```

## Quoting prompts

`context.json` has `config.promptQuoting`:

- `paraphrase` (default): summarize what the user asked in your own words.
- `verbatim`: quote prompts as given in the digest, inside blockquotes.

Never quote `delegations`: those are the agent's own instructions to its
subagents. Mention them in one line if they matter ("ran three research
subagents").

## Style

- Plain language. Short paragraphs. No marketing tone.
- Don't overclaim: "matched", "made during the session", not "wrote".
- Be honest about gaps. If `stats.unmatchedPct` is high, say much of the change
  was hand-written or not traceable.
- If the digest `notes` say the description covers uncommitted changes, say so.
- Keep it under about 600 words, not counting the collapsed trace.
- Never include absolute paths, usernames, tokens, or content from other repos.

## Check every claim before rendering

Go through `body.md` sentence by sentence. Each claim must come from one of
these: the digest, the diff, or something you did and can point to in this
session. The preview shows the digest's facts in an "Evidence" section, so the
user can do the same check.

- **Numbers** (lines matched, commits, test counts) are copied from the digest,
  not estimated.
- **Tests:** say they passed only if the digest's test runs show it. If a run
  failed and a later one passed, say that; it's part of the story.
- **Don't explain gaps you can't see.** If some lines match no agent edit, say
  so plainly. Don't guess why (for example "mostly formatting") unless the diff
  shows it.
- **Plans and decisions:** say a plan was approved only if the digest says
  so; describe a decision only from its recorded question and answer.
- **Things that happened outside the logs** (for example, a manual check the
  user did) need the user's word for it, not yours.
