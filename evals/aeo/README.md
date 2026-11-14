# AEO eval: do agents find and use Tracetoon?

"Agent engine optimization": when a user asks a coding agent to open a PR, how
often does the agent **discover** Tracetoon, **suggest** it, **install** it and
**run** it? This harness runs real agent CLIs headlessly against a throwaway
repository and scores each run from its transcript, its on-disk session log and
a recording `gh`.

Nothing here touches GitHub. Every run gets its own temp folder with:

- `repo/`: a small repository with `main` pushed to a local bare `remote.git`
  and an unpushed `feature/greeting` branch (two commits, ready for a PR);
- `home/`: an empty HOME. `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`, the XDG folders and (on Windows) `APPDATA`/`LOCALAPPDATA` point
  into it, so the agent sees none of your real config, skills, hooks or logs. A
  seeded Claude Code session there "wrote" the branch, so Tracetoon has evidence
  to work from; scoring ignores it;
- `bin/gh`: a shim (`gh-shim.ts`) first on `PATH` that records every call to
  `gh.jsonl` and answers offline. Tracetoon reaches the same shim through
  `TRACETOON_GH_SCRIPT`. Folders with an existing `tracetoon` command are dropped
  from `PATH`.

## What is measured

Prompt tiers (`prompts.json`):

| tier | name            | prompt                                                                                                                |
| ---- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1    | unprompted      | Open a PR for this branch.                                                                                            |
| 2    | hinted          | Open a PR for this branch with a description that shows how the change was built and tested.                          |
| 3    | category        | Is there a tool that writes PR descriptions from my coding agent's session logs? Use it to open a PR for this branch. |
| 4    | named (control) | Use Tracetoon to open a PR for this branch.                                                                           |

Conditions (`fixture.ts`):

| condition    | what the agent starts with                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `clean`      | nothing                                                                                                |
| `skill`      | the shipped skill (`plugin/skills/tracetoon` plus its freshly built bundle) in the host's skill folder |
| `skill+hook` | the skill plus `tracetoon hook install` into the temp HOME                                             |
| `agents-md`  | only an `AGENTS.md` pointer in the repo (Claude also gets `CLAUDE.md` → `@AGENTS.md`)                  |
| `mcp`        | reserved for a later phase; not implemented                                                            |

`--web on|off|both` toggles the agent's web tools where the CLI allows it
(Claude `--disallowedTools WebFetch,WebSearch`; Codex `--search` vs
`web_search="disabled"`; OpenCode tools off in its config).

Stages (`score.ts`), each from the stdout transcript **or** the on-disk session
log read with Tracetoon's own trace adapters:

| stage    | true when                                                                                                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| discover | "tracetoon" appears in something the agent produced or pulled in: its text, a tool call, a tool result (hook redirect, directory listing), or a web search/fetch. The user's prompt and the host's startup skill list don't count, so tier 4 is not discovery by default. |
| suggest  | the agent's own text names Tracetoon, or it used it (skill call, `tracetoon …` command)                                                                                                                                                                                   |
| install  | Tracetoon was usable without a human: `preinstalled` by the condition, or agent-driven (`skill-dir`: a SKILL.md appeared in a host skill folder in the temp HOME; `command`: a `tracetoon …` command succeeded)                                                           |
| run      | a PR the shim recorded (`pr create`/`pr edit`) carries `<!-- tracetoon:start -->`, which only `tracetoon publish` writes                                                                                                                                                  |

Also recorded per run: PR created at all, skill trigger (Claude `Skill` tool for
tracetoon, or any read of `skills/tracetoon/SKILL.md`), Tracetoon commands and
how many succeeded, web and tool calls, turns, tokens, cost (when the CLI reports
it) and wall time.

## Running it

```sh
bun run dependencies:prepare && bun install
# See the plan first; nothing runs:
bun evals/aeo/run.ts --agents claude,codex,opencode --tiers 1,2,3,4 \
  --conditions clean,skill,skill+hook --trials 5 --dry-run
# One cheap real run:
bun evals/aeo/run.ts --agents claude --tiers 4 --conditions skill --trials 1 \
  --out evals/aeo/results/smoke-$(date +%F).json
```

Options: `--web on|off|both` (default `on`), `--timeout <minutes>` per run
(default 10), `--keep` keeps each fixture folder for inspection,
`--copy-credentials` (below). Results go to `<out>.json` (every run plus the
summary) and `<out>.md` (the table). Scrubbed raw transcripts, stderr, gh calls
and adapter-read sessions go to `<out>-runs/` (git-ignored). Re-render a table
with `bun evals/aeo/report.ts <out>.json`.

**Cost.** Every cell is a full agentic session, and the skill conditions run
Tracetoon's whole workflow (reviewers included). The full matrix above is
3 agents × 4 tiers × 3 conditions × 5 trials = 180 sessions, several minutes
each; expect tens of dollars or more per agent. Start with `--dry-run`, then a
single trial.

### Authentication

Agents authenticate from environment variables, which are passed into the
isolated environment:

| agent       | variable                                           | notes                                                                                                                                               |
| ----------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) | model: `AEO_CLAUDE_MODEL`                                                                                                                           |
| Codex       | `OPENAI_API_KEY` (passed as `CODEX_API_KEY` too)   | model: `AEO_CODEX_MODEL`; sandbox: `AEO_CODEX_SANDBOX` (default `workspace-write`, which blocks network installs; `danger-full-access` allows them) |
| OpenCode    | `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`            | model: `AEO_OPENCODE_MODEL` or `OPENCODE_MODEL` (`provider/model`)                                                                                  |

An agent whose CLI is missing, or that has no key, is skipped with a note in the
results. Locally, `--copy-credentials` instead copies your existing login file
(`~/.claude/.credentials.json`, `~/.codex/auth.json`,
`~/.local/share/opencode/auth.json`) into the temp HOME and deletes it with the
fixture. A Claude login that expires within 30 minutes is refused, because a
refresh inside the fixture could rotate the token your real login holds. (macOS
keeps the Claude login in the keychain, so use a key there.)

### CI

`.github/workflows/aeo.yml` runs on `workflow_dispatch` (inputs: agents,
tiers, conditions, trials) and weekly. It needs repository secrets
`ANTHROPIC_API_KEY` (Claude Code, OpenCode) and `OPENAI_API_KEY` (Codex); agents
without their key are skipped. Results are uploaded as a workflow artifact and
never committed automatically.

## Adding an agent

1. The host must exist in `src/integrations/registry.ts` (that is where its skill
   folder and log adapter come from). Add its id to `HostId` in `fixture.ts` and
   its home folder to `hostHome` there.
2. In `agents.ts`, add an `AgentSpec`: binary, the help command whose text you
   check for version-dependent flags, auth variables, the headless, no-prompt
   arguments with machine-readable output, and how to turn web tools off.
3. In `score.ts`, add a stdout parser to `PARSERS` (normalize to `text`, `tool`,
   `result` and `web` events, plus usage and cost) and its trace adapter ids to
   `HOST_ADAPTERS`. Add a tiny scrubbed transcript under `fixtures/` and a case
   to `tests/aeo-eval.test.ts`.
4. Install the CLI in `.github/workflows/aeo.yml` behind its secret.
