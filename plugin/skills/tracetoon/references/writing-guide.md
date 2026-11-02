# Writing the PR description

The goal: **a reviewer reaches an accurate understanding of the change and its
evidence with as little avoidable effort as possible.** After reading the title
and the first paragraph, they should be able to say what is being proposed, why
it matters, where to look, and what supports it.

The trace gives you what a diff can't: what the user asked for, what they
decided, what was tried, and what actually ran. Use it to explain the *why* and
the *evidence*. The diff already shows the *what*.

Write a complete, useful draft from what's available. Don't wait for, or ask
for, more input. (`render` prints optional notes about missing
facts; see "Missing facts" below.)

## The title

The title is a compact, accurate identifier for the change. Its job is smaller
than the body's: it lets the right maintainer recognize the area, understand the
main action or effect, and tell this PR apart from other changes to the same
code. The body explains.

**What to keep** (a way to decide what earns a place, not a template):
required metadata + the main change + the affected object + the qualifier that
prevents a wrong reading. A feature name, a version requirement, a revert and a
bug fix all take different shapes.

- "Keep a PR's own work when the base branch is merged into it": the
  behavior, and the situation it applies to.
- "Commands quoted inside scripts and heredocs no longer count as test runs":
  the object, the condition, the effect.
- "Fix ICE when multiple RegionOriginNotes add the same diagnostic arg": the
  failure, the affected object, the trigger.

**Rules:**

- **Name what the PR actually does**, not the goal it serves or the issue's
  broader wish. Comment-only work is an explanation, not a behavior change.
  Performance or safety claims need their scope ("for short non-ASCII
  strings") and evidence; with no captured measurement, leave the claim out.
- **Keep the one qualifier that separates this change** (the trigger, the
  condition, the operation). "Fix timeout" is a neighborhood; "Fix connect
  timeout during the TLS handshake" is the change. Keep a word that rules out
  a likely wrong reading ("workspace package" so nobody expects an npm
  release). Beyond that, detail goes in the body: provider lists, version
  numbers, counts and secondary effects.
- **Use the code's real names**: the API, option, error, file or command a
  maintainer would search for. A bare code (an issue number, a rule ID, a CWE)
  doesn't explain anything on its own; pair it with the behavior.
- **The change that matters most, not the biggest diff.** Cover the whole PR
  at the level of its main change, not the latest commit. Read the commit
  subjects; reuse a good one if it fits. The main change is usually what the
  user asked for: if they asked for something visible (a clickable link, a new
  option), it belongs in the title even when fixes found along the way touched
  more code. Name what's **new**, not what already existed ("draw with Codex
  or Antigravity", not "draw with AI" if AI drawing was already there).
- **Two separate changes:** when a PR has two that a maintainer would both want
  to know about, a short "X, and Y" is better than hiding one, if it fits the
  budget. Small fixes that came along go in the body. Three or more separate
  changes mean the PR covers too much: tell the user and title the main one.
- **No taglines or headlines** ("Better PRs: X, Y and Z"), no "This PR…", no
  marketing words, and no trailing period unless the repo wants one.
- **Length:** follow the repo's limit if it has one. Otherwise treat about 72
  characters as the budget: if a draft is longer, move detail into the body
  (lists, numbers, secondary effects, explanations of why) until it fits. Only
  go over when the one essential qualifier can't be said shorter, and never cut
  that qualifier to save space.
- **Repo conventions come first.** `titleRules` in `context.json` lists what the
  repo asks for: a Conventional Commits type (`feat:`, `fix:`) when a check
  enforces it, an issue prefix (`gh-1234: `), a length limit, and whether the
  title becomes a squash commit subject or a release-note line. Follow written
  and enforced rules. Recent titles are only examples. Don't add a type prefix
  the repo doesn't use. A correct prefix doesn't make a vague title good.

**Existing PRs:** keep the current title unless the change's scope has moved.
Tracetoon keeps a title a person edited on GitHub; replace it only if the user
agrees (`tracetoon render --retitle`).

`render` runs an advisory title check (distinction, shape, truth, scope, repo
rules) and lists anything to revise in its output. Fix what
applies; it never blocks publishing.

## If the user already wrote something

If `body.md` already has text the user wrote, or the PR already has a
description written by someone (`context.json`: `existingPr.humanBody`, or a
managed region they edited), **keep it**. Edit only to fix statements the
evidence contradicts, and add what's missing (a test result, a scope change since
they wrote it). Don't restructure it into the shape below.

## If the repo has a PR template or conventions

Follow them: the template's sections in its order, and any rules in CONTRIBUTING
or AGENTS.md about PR text. They take priority over everything below.

In the three-role workflow, the drafter also receives validated `guidance.json`.
Follow each applicable source-backed requirement with its scope and exceptions.
Preserve human-only sections and missing-evidence gaps. The independent reviewer
checks the full rendered PR afterward; route corrections through the drafter.

## Before writing: read the old code, then map the change

Inaccurate descriptions cost more than thin ones. In a study of 23K agent PRs,
the most common mismatch was a description claiming changes the code didn't
make, and highly inconsistent PRs were merged far less often (Gong et al.,
MSR 2026). Reviewers' main difficulty is understanding the change and its
reason (Bacchelli & Bird, ICSE 2013). Three steps before any prose:

1. **Read the old code.** `changes.patch` shows only a few lines around each
   change. Read the base version of the main changed functions
   (`git show <mergeBase>:<path>`) and their direct callers. State the old
   behavior from what you read; a guessed "before" is a common source of
   wrong claims.
2. **Map the change by idea.** Write `change-map.json` (format in
   [contribution-workflow.md](contribution-workflow.md)):
   - Group every change by the idea it serves, not by file. Related parts
     reviewed together are understood better (Baum et al., ICSME 2017), and
     composite changes are hard to review untangled (Tao et al., FSE 2012).
   - Put the main idea or the riskiest part first, then its test, then what is
     mechanical. Reviewers give later files less attention (Fregnan et al.,
     FSE 2022).
   - Every behavior file belongs to a group. The body is written from the map,
     so an idea missing from the map is usually missing from the body.
   - A file can change several contracts. Add evidence-backed `behaviorChecks`
     for material conditions, defaults, fallbacks, public options and regression
     intent within each idea. Cover those distinctions in concise prose; do not
     copy the checklist or enumerate incidental constants and implementation steps.
3. **Trace any example.** If the body will include a concrete example, run it
   by hand through the old and the new code first. Record the lines you
   relied on in the map's `example.refs`. An example that doesn't match the
   code is worse than none. Edge cases found while tracing belong in the body's
   limits or consequences.

The map is a local working file. Never paste it into the body as a list.
See [contribution-workflow.md](contribution-workflow.md) for the role prompts and
handoff contracts. A recommendation is not a mandatory submission gate, and a
project's explicit testing exception must not become a blanket local-test rule.

## Shape it by the kind of change

First decide what kind of change this is, then answer the questions that matter
for that kind. These are questions, not required sections: omit what doesn't
apply, and combine short answers into one paragraph.

| Kind | What usually matters most |
|---|---|
| Small bug fix | Trigger, old vs new behavior (one concrete input, if it helps), cause, a narrow regression check |
| Feature or API | The contract, one concrete example call and result, the boundary (what it deliberately doesn't do), compatibility |
| Refactor | What stays the same (the invariant, shown on one input if it isn't obvious), why restructure, mechanical vs behavioral parts |
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
<One paragraph: the problem and the result. Where it came from when the trace
shows it (what the user reported or asked for, a failure seen while testing,
found while dogfooding another PR). Then the old behavior, read from the base
code, and what is different now. Write for a maintainer who knows the
codebase: only the narrow context this change touches, never a primer. A
concrete before/after example (one small input, traced through the code) when
it removes doubt.>

<Approach, when it isn't obvious: why this way. Mention an alternative only if
it was really considered and explains the choice. Say who decided only when the
trace shows it.>

<Evidence: what was checked and what it showed, worded to the evidence (below).
Say what wasn't verified when it matters.>

<Consequences, only if concrete: changed defaults, compatibility, new costs.>

<Review path, for anything bigger than a small fix: one to three short lines
in the change map's order. The main idea or riskiest part first, then the key
test, then "the rest is mechanical" when it is. Name files by role, at most one
per step.>

<Feedback wanted: only when the trace shows a real open decision (an approach
not discussed, a trade-off left to the reviewer). Name it in one line. Never
invent one.>
```

A review path is not a file list: it says what to read first and why, and puts
the rest in one group. Developers rate a dependency-aware reading order above
alphabetical file order. Long file-by-file "review order" sections, though,
go with lower merge rates (Pirouzkhah et al., MSR 2026). Saying which feedback
you want is rare, but it is one of the strongest signals of engaged review in
the same study.

Use headings only when the description is long enough to need them.

## Evidence wording: don't upgrade a fact

Read `evidence-notes.md` before drafting validation. It is available immediately
after `digest`, including relevant historical successes, current receipts and
stale or unavailable checks. Expand individual facts when needed; `digest-full.json`
keeps their complete redacted text. Historical and compact facts have the same ids.
For an already completed branch, reuse this evidence first. Fresh checks are for
applicable repository requirements or material validation gaps, not a prerequisite
to writing the description. State fresh checkout limitations separately from
implementation-session results. Neither establishes hosted CI status.

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
  with its outcome and how that's known. For historical R facts, say
  "`bun test` passed during development (96 pass, 0 fail); tested content was
  not verified." The legacy `revision: no later edits seen` tag is only a
  heuristic over normalized edit records: shell writes can be missed even in
  the same session. Never turn it into "no later edits" or "after the final
  edits." If `revision` is `before later edits`, say it passed before those
  changes. Current matching-content claims require a V receipt. Skip runs marked
  `after later work`: they
  tested code that isn't in this PR. If `outcome` is `unknown`, don't claim a
  result. If `pr.dirty` is true, a run may have covered code that isn't in the
  PR.
- If a run failed and a later one passed, you can say so when it helps the
  reviewer.
- A later failure does not erase a real earlier pass. Say which command passed
  during development and whether later edits followed; do not present an earlier
  result as current. A pass for one test file or flag set does not establish a
  different command, the whole suite, or a particular unnamed new regression.
- Never invent a test count, a pass, or a measurement. Never turn missing
  evidence into a claim that something wasn't done.

## Voice and attribution

- **Matter-of-fact and neutral.** "Adds…", "Keeps the existing response shape so
  older clients still parse it." No marketing tone, no filler ("This PR
  implements…", "improves code quality").
- **Don't put words in anyone's mouth.** "I chose X because…" claims who decided
  and why. Write it only when a prompt, a recorded decision or the user's own
  text supports it. Otherwise state the reason neutrally, or leave it out.
- **Where the change came from is context only the trace has.** The user's
  report or request ("a Codex test showed the PR link couldn't be
  clicked") tells a reviewer why the change exists; put it in a sentence,
  paraphrased per `promptQuoting`. When the user asked for an outcome and no
  plan or decision about *how* was recorded, a short neutral note helps the
  reviewer know which choices are open to push back on, e.g. "The approach (a
  quote-aware splitter) wasn't discussed in the session."
- **Facts that only a commit message states** ("fixes the gap noted in #8",
  "found while dogfooding", a showcase result) can be used, attributed: "per
  the commit message" or "the commit notes…". Don't present them as observed.
  Redacted `pr.commits[].body` carries these explanations; cite them locally as
  `commit:<sha>`. Include a relevant issue, PR or documentation reference when
  it explains the change. A reference alone does not establish a saga relationship.
- **Decisions:** a recorded decision tells you what was *chosen*. An option that
  wasn't picked isn't automatically "rejected", and a plan sent back isn't proof
  its design was wrong. Give a reason only when the source gives one.
- **Alternatives:** never present unshipped work (a plan, an attempt, an idea)
  as implemented. Describe a relevant alternative explicitly as an alternative.
- Don't narrate the agent's process in first person ("I checked…", "I placed…").
  Mentioning the agent or model by name is fine where it's relevant, such as the
  disclosure or a PR about agent tooling.

## Keep it economical

- **No file-by-file change lists.** Give a short review path by role (the main
  logic, the key test, the mechanical rest). The diff already lists files.
- **No test-count inventories** ("96 tests, all passing"). Say what was checked
  that matters for this change.
- **Each fact once.** Don't repeat the request, decisions or results in several
  sections.
- **Keep negative information in the main text** when a reviewer needs it:
  limitations, unverified areas, follow-ups. Don't hide it in a collapsed block.
- `stats.unmatchedPct` means lines **not matched to captured evidence** (missing
  sessions, formatters, shell edits, generated files, hand edits). Don't call
  them hand-written, and don't put match percentages in the description. `render`
  reports them.

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
Write around it, or note it briefly if it matters. `render` prints
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

`tracetoon render` runs an advisory check and its output marks what it finds.
Use it to fix wording. It never blocks publishing.
