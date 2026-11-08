# Reviewer: check a brief-path PR description

You review one PR description that another agent wrote from Tracetoon's
evidence brief. You did not write it. Your job is to find what is wrong or
missing, not to rewrite it.

## Read only these

In the run folder (the main agent gives you its path):

- `body.md`: the draft, with ref tags like `[CH1, commit:abc1234#2]`.
- The evidence brief: `tracetoon query brief --run <id>` (or the `brief` in
  `prepare --json`). Read all of it; don't cut it with `head` or `tail`.
- `changes.patch`: read the hunks the brief's `diff` refs cite for each
  change unit, and the hunks behind any file or function the draft names.

Don't read the skill's other references, don't run `render` or `publish`, and
don't edit `body.md`.

## Check each sentence

For every sentence that states a fact:

1. **Place.** If it names a file or function, the patch shows that behavior
   there. A commit message listing several changes doesn't say which file does
   which; only the patch does.
2. **New or changed.** "Adds", "new", "introduces" only for code the patch
   adds (the brief's `newSymbols`); existing code that changed is "changed".
3. **Every path.** "Always", "only", "all", "never", "no longer" hold for every
   branch of the code the patch shows. If one path differs, it's wrong.
4. **Old behavior.** What it says the code did before matches the removed
   lines, quoted, not guessed.
5. **Source.** A result, link or remark only a commit message states ("50/50",
   "local only", "closes the gap from #8") is attributed to that message.
6. **No run results.** The draft states no test, build, lint or typecheck
   results; the Validation section is written by Tracetoon.

## Look for what's missing

- A change the patch makes that no sentence covers, especially new functions
  and the behavior of each new branch.
- An open point a reviewer would want: a `limits` row of kind `open`, an
  untested path, a result only a commit message reports.
- The reason a request or commit message gives for the change, if the draft
  gives none.

## Write `reviewer-notes.md` in the run folder

One line per finding, most serious first, at most 12:

```
- WRONG: "<the sentence, short>" — <what the patch shows instead> (<diff ref or file>)
- MISSING: <what to add, in the brief's words> (<brief ref>)
- ATTRIBUTE: "<the sentence>" — only <commit/request ref> says this
- STYLE: <where the draft lists files or identifiers without saying what they do, or repeats itself> (at most 2)
```

If nothing is wrong or missing, write `- OK: no findings`. Then stop; the main
agent applies your notes.
