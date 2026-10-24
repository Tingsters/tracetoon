# Writing the PR description

The goal: **a reviewer reaches an accurate understanding of the change and its
evidence with as little avoidable effort as possible.** After reading the title
and the first paragraph, they should be able to say what is being proposed, why
it matters, where to look, and what supports it.

The trace gives you what a diff can't: what the user asked for, what they
decided, what was tried, and what actually ran. Use it to explain the *why* and
the *evidence*. The diff already shows the *what*.

Write a complete, useful draft from what's available. Don't wait for, or ask
for, more input. (The preview offers the user optional notes about missing
facts; see "Missing facts" below.)

## If the user already wrote something

If `body.md` already has text the user wrote, or the PR already has a
description written by someone (`context.json`: `existingPr.humanBody`, or a
managed region they edited), **keep it**. Edit only to fix statements the
evidence contradicts, and add what's missing (a test result, a scope change since
they wrote it). Don't restructure it into the shape below.

## If the repo has a PR template or conventions

Follow them: the template's sections in its order, and any rules in CONTRIBUTING
or AGENTS.md about PR text. They take priority over everything below.

## Shape it by the kind of change

First decide what kind of change this is, then answer the questions that matter
for that kind. These are questions, not required sections: omit what doesn't
apply, and combine short answers into one paragraph.

| Kind | What usually matters most |
|---|---|
| Small bug fix | Trigger, old vs new behavior, cause, a narrow regression check |
| Feature or API | The contract, an example, the boundary (what it deliberately doesn't do), compatibility |
| Refactor | What stays the same (the invariant), why restructure, mechanical vs behavioral parts |
| Performance | Workload, mechanism, baseline vs result, environment, regressions |
| UI | Before/after, states to check, how to see it |
| Migration or infra | Deployment order, failure behavior, rollback limits |
| Prototype or draft | Stage, known gaps, the decision you want from reviewers |
| Maintenance | The specific reason, any surprising boundary; minimal ceremony |

A tiny fix can be two or three sentences. A change with interacting contracts
earns more. **Length should follow how much uncertainty the text removes**, not
a template.

## A flexible default (when there's no template)

```markdown
<One paragraph: the problem and the result. What was wrong or missing, and what
is different now. A concrete before/after example when it helps.>

<Approach, when it isn't obvious: why this way. Mention an alternative only if
it was really considered and explains the choice. Say who decided only when the
trace shows it.>

<Evidence: what was checked and what it showed, worded to the evidence (below).
Say what wasn't verified when it matters.>

<Consequences, only if concrete: changed defaults, compatibility, new costs.>

<Where to start reviewing, for anything bigger than a small fix: the main file
or test, by role. Add a specific question only if there is a real open decision.>
```

Use headings only when the description is long enough to need them.

## Evidence wording: don't upgrade a fact

| What the trace shows | You can say | Don't say |
|---|---|---|
| A test file changed | "Adds a test for the empty case" (if the test does that) | "All tests pass" |
| A command was in a plan | "Plan: run X" | "Ran X" |
| A test run passed | "`bun test` passed in the session" | "No regressions", "works everywhere" |
| A run passed, then files changed | "passed before the last edits" | "passes on this revision" |
| A benchmark number | "measured N on workload W" | "it's faster" |
| The user said they checked something | "Checked in Safari (reported by the author)" | "Verified" |
| Nothing recorded | (say nothing, or "no result was captured for X") | "not tested" (it may have been, outside the logs) |

- `runs` (see `digest-schema.md`) list each test, build, lint and type check
  with its outcome, how that's known, and how it relates to later edits. Word a
  claim to match: "`bun test` passed (96 pass, 0 fail) after the last edits
  captured" is supported by an `R#` with `outcome: passed` and
  `revision: no later edits seen`. If `revision` is `before later edits`, say it
  passed before the final changes. If `outcome` is `unknown`, don't claim a
  result. If `pr.dirty` is true, a run may have covered code that isn't in the
  PR.
- If a run failed and a later one passed, you can say so when it helps the
  reviewer.
- Never invent a test count, a pass, or a measurement. Never turn missing
  evidence into a claim that something wasn't done.

## Voice and attribution

- **Matter-of-fact and neutral.** "Adds…", "Keeps the existing response shape so
  older clients still parse it." No marketing tone, no filler ("This PR
  implements…", "improves code quality").
- **Don't put words in anyone's mouth.** "I chose X because…" claims who decided
  and why. Write it only when a prompt, a recorded decision or the user's own
  text supports it. Otherwise state the reason neutrally, or leave it out.
- **Decisions:** a recorded decision tells you what was *chosen*. An option that
  wasn't picked isn't automatically "rejected", and a plan sent back isn't proof
  its design was wrong. Give a reason only when the source gives one.
- **Alternatives:** never present unshipped work (a plan, an attempt, an idea)
  as implemented. Describe a relevant alternative explicitly as an alternative.
- Don't narrate the agent's process in first person ("I checked…", "I placed…").
  Mentioning the agent or model by name is fine where it's relevant, such as the
  disclosure or a PR about agent tooling.

## Keep it economical

- **No file-by-file change lists.** Point to where to start, by role (the main
  logic, the key test). The diff already lists files.
- **No test-count inventories** ("96 tests, all passing"). Say what was checked
  that matters for this change.
- **Each fact once.** Don't repeat the request, decisions or results in several
  sections.
- **Keep negative information in the main text** when a reviewer needs it:
  limitations, unverified areas, follow-ups. Don't hide it in a collapsed block.
- `stats.unmatchedPct` means lines **not matched to captured evidence** (missing
  sessions, formatters, shell edits, generated files, hand edits). Don't call
  them hand-written, and don't put match percentages in the description. The
  preview shows them.

## Quoting prompts

`context.json` has `config.promptQuoting`:

- `paraphrase` (default): describe what the user asked in neutral words.
- `verbatim`: quote prompts as given in the digest, inside blockquotes.

Never quote `delegations` (the agent's instructions to its subagents).

## Disclosure

Tracetoon adds the comic and the disclosure after your text; don't add an "AI
assistance" section. If the repo's policy asks for a particular disclosure form,
`context.json` says so. Write it in that form at the end, in one or two lines.

## Missing facts

When the trace lacks something a reviewer would want (why an approach was taken,
whether a manual check was done), **don't fill the gap with a plausible story**.
Write around it, or note it briefly if it matters. The preview shows the user
optional notes for exactly these gaps. If they add context, their words are
author-reported facts you can use.

## Before rendering: check every claim

Go through `body.md` sentence by sentence. Each claim must come from the digest,
the diff, or the user's own words. Pay special attention to:
- **Numbers and results:** copied from the digest, never estimated.
- **Scope:** everything significant in the diff is covered, and nothing that
  isn't in the diff is described as done.
- **Plans and decisions:** only what the digest records.
- Never include absolute paths, usernames, tokens, or content from other repos.

`tracetoon render` runs an advisory check and the preview marks what it finds.
Use it to fix wording. It never blocks publishing.
