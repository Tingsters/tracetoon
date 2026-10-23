# Manual mode (no Tracetoon runtime)

Use this only when the launcher exits with code 3 and the user declined the
download. You do the reading yourself, with the same care the tool would take.

## 1. Work out the PR

```sh
git rev-parse --abbrev-ref HEAD                       # head branch
git merge-base origin/main HEAD                       # use the repo's default branch
git log --format='%h %s' <merge-base>..HEAD
git diff --stat <merge-base> HEAD
```

## 2. Find the sessions

Claude Code keeps one JSONL file per session in
`~/.claude/projects/<folder>/<session-id>.jsonl` (or under `$CLAUDE_CONFIG_DIR`).
Each line has `type`, `timestamp`, `cwd`, `gitBranch` and `message`.

- Pick files modified since the first commit on the branch.
- Keep only lines whose `cwd` is inside this repository. Ignore everything else:
  it belongs to other projects.
- User prompts: `type: "user"` lines whose `message.content` is a plain string
  (skip ones wrapped in tags such as `<command-name>` or `<system-reminder>`).
- Edits: `tool_use` blocks named `Edit`, `Write` or `MultiEdit`.
- Plans: `tool_use` named `ExitPlanMode` (`input.plan`).
- Commands: `tool_use` named `Bash` (`input.command`).

Read only what you need. Do not copy secrets, tokens, absolute paths or other
projects' content into the description.

## 3. Write, show, and post only with approval

Write the description following [writing-guide.md](writing-guide.md). Show the
user the full title and body. Only after they approve:

```sh
gh pr create --title "<title>" --body-file <file>       # new PR
gh pr edit <number> --body-file <file>                  # existing PR
```
