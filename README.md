# Tracetoon

**Pull requests that show how the change was made, with a comic.** Tracetoon
reads the session logs your AI coding agents already keep on your machine, finds
the sessions that produced your branch, and helps your agent write a PR
description covering the plan, the decisions, what was tested, and how much was
AI-assisted. It adds a one-off comic of the story, with characters and an art
style made up for that PR.
You see the exact text and comic and approve them before anything is posted.

- **Install after the fact.** Write your code first with any supported agent,
  then add Tracetoon. It reads logs that already exist: no background capture,
  no history database.
- **Preview first.** Posting requires an approval code tied to the exact text
  and image you previewed. An optional yolo mode skips the preview only when
  every safety check passes.
- **Private by default.** Only records from this repository are used. Secrets,
  personal data, your home path and username are redacted, and a second scanner
  checks the final text before it can be posted. Image services only ever see
  the comic's scenes, and only after you agree.
- **Every comic is its own.** No mascots or recurring cast: each PR's comic
  invents its own characters, and picks an art style the repo hasn't used
  lately. The only thing read back from earlier PRs is which styles they used.

| Agent | Status |
|---|---|
| Claude Code | supported |
| Codex (CLI and app) | supported |
| Antigravity (CLI and IDE) | supported |
| Gemini CLI | runs the skill (its own logs aren't read yet) |
| Copilot CLI | planned |

## Install

One command installs Tracetoon for every agent on your machine (Claude Code,
Codex, Antigravity, Gemini CLI), with a prebuilt binary, so nothing else is
needed:

```sh
# macOS, Linux, Git Bash
curl -fsSL https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.ps1 | iex
```

The installer also puts a `tracetoon` command on your PATH and ends with a
line about comics: which image route it found and what to do next. Restart your
agent, then in any repo with your work on a branch, ask:
*"Open a PR for this branch with Tracetoon."*

### Set up comics (optional)

Comics are drawn by an image model you choose. Without one, PRs simply have no
comic. Run `tracetoon images` to see what's on your machine:

- **Codex CLI** (recommended if you have ChatGPT): install it and run
  `codex login` with your ChatGPT account. Images count toward your plan's
  Codex usage; no key needed. Codex set up for another model provider (in
  `~/.codex/config.toml`, e.g. a LiteLLM proxy) has no image tool.
- **Antigravity CLI** (experimental): signed in, it uses your Antigravity quota.
- **OpenAI or Gemini API**: set `OPENAI_API_KEY` or `GEMINI_API_KEY`, billed
  per image to your key. On Windows run `setx OPENAI_API_KEY "<key>"`; on macOS
  or Linux add `export OPENAI_API_KEY="<key>"` to your shell profile. Then
  restart your agent so it sees the key.

Approve one route and check it really draws (one small test picture, no repo
content): `tracetoon images --approve codex --test`. Your agent offers the same
thing at the start of your first PR.

Re-run the command to update. To remove, set `TRACETOON_UNINSTALL=1` and run it
again. Downloads are checked against the release's SHA-256 checksums.

### Tracetoon is the default for PRs, and easy to turn off

The installer adds a small hook to each agent. When an agent tries to open a PR
with `gh pr create` (or rewrite one with `gh pr edit --title/--body`), the hook
stops it and points it to Tracetoon, so you always get a preview first. It only
touches its own entries in each agent's config, backs up each file before the
first change, and lists every file it changed. Skip it with
`TRACETOON_NO_HOOK=1`. Codex asks you to trust a new hook once (`/hooks`), and
the Antigravity IDE picks it up after a restart.

Turn it off at whichever level you need. Any "off" wins:

| Scope | Off | On again |
|---|---|---|
| One command | `TRACETOON=0 gh pr create ...` | (just once) |
| You, everywhere | `tracetoon off` | `tracetoon on` |
| This repo, for everyone | `tracetoon off --repo` (writes `.github/tracetoon.json`; commit it) | `tracetoon on --repo` |
| This repo, just you | `tracetoon off --local` (git config) | `tracetoon on --local` |
| CI | off automatically when `CI=true` | `TRACETOON=1` |

`tracetoon status` shows whether it's on here and which setting decided.

<details>
<summary>Other ways to install</summary>

- **Claude Code plugin:** `/plugin marketplace add Tingsters/tracetoon`, then
  `/plugin install tracetoon@tracetoon`.
- **By hand:** unzip `tracetoon-skill.zip` (or a per-platform
  `tracetoon-skill-<os>-<arch>.zip`, which includes the binary) from a
  [release](https://github.com/Tingsters/tracetoon/releases) into your agent's
  skills folder:

| Agent | Folder |
|---|---|
| Claude Code | `~/.claude/skills/tracetoon` |
| Codex | `~/.agents/skills/tracetoon` (or `.agents/skills/` in a repo) |
| Antigravity | `~/.gemini/config/skills/tracetoon` (or `.agents/skills/` in a repo) |
| Gemini CLI | `~/.gemini/skills/tracetoon` |

</details>

## How it works

1. **`tracetoon digest`** reads the branch from git (base, commits, the exact
   lines added), finds agent sessions that touched this repository, and scores
   them. The evidence: edits whose lines are still in the diff, commits made
   during the session (this also finds work done in worktrees since deleted), a
   PR link, the branch, timing and working folder. Subagents fold into their
   parent session. The result is a redacted digest sized for an LLM.
2. **`tracetoon context`** reads the PR template, any AI-contribution policy, the
   existing PR, your settings, and the art styles of the repo's recent comics.
3. **Your agent writes** `body.md` and a comic brief (`comic.json`) from the
   digest. It finds the funny part of how the work went, then picks:
   - a format: a gag strip, a before/after, a splash page, a mission briefing, a
     movie poster, an instruction manual and more;
   - characters invented for this PR's joke;
   - any art style that suits the mood: one of 18 ideas (manga ink with one red
     accent, noir, silver-age comics, ligne claire, claymation, 16-bit pixel art
     and more) or its own description, different from the recent ones.
4. **`tracetoon comic art` / `comic render`** draw the whole page, lettering
   included, with an AI image model you allow: your agent's own image tool, the
   Codex or Antigravity CLI already on your machine (your own login, no key), or
   OpenAI or Gemini with an API key. Tracetoon adds a footer bar (`owner/repo
   #N · made with Tracetoon`). Without an image route, the PR simply has no
   comic. `tracetoon comic reroll` redraws it in
   another style.
5. **`tracetoon render`** builds the final body (Tracetoon only owns a marked
   region, so your own text in an existing PR is kept), scans it for leaks and
   prints an approval code.
6. **`tracetoon publish --code <code>`** uploads the comic to the repo's
   `tracetoon-assets` branch (or as a GitHub attachment for private repos) and
   creates or updates the PR with `gh`.

Other commands: `status`, `on`/`off`, `hook install`/`uninstall`, `scan`,
`expand`, `preview`, `images`, `export --agent-trace`
([Agent Trace](https://agent-trace.dev) line attribution), `doctor --probe`,
`config`. Every command takes `--json`.

If the repo already records provenance with [Entire](https://entire.io)
checkpoints or git-ai notes, the digest says so. Run files live in
`.git/tracetoon/runs/`, which git never tracks.

## Running it

The skill ships a small launcher (`bin/tracetoon`, `bin/tracetoon.cmd`). It uses,
in order: a prebuilt binary next to it or cached, Bun, or Node 22+ with the
bundled `dist/tracetoon.mjs`. With your permission it can instead download the
release binary with `gh` and verify its checksum. Per-platform skill zips with
the binary included are attached to each release.

## Settings

`tracetoon config set <key> <value>`, or per repo in `.github/tracetoon.json`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Use Tracetoon for PRs (also `tracetoon on`/`off`) |
| `style` | `auto` | Pin one art style for every comic (an idea from `references/styles.md` or any description), or `auto` to vary |
| `comic` | `true` | Make a comic at all |
| `yolo` | `false` | Allow `publish --yolo` to skip the preview when all checks pass |
| `promptQuoting` | `paraphrase` | `verbatim` quotes your prompts in the PR |
| `disclosure` | `assisted-by` | Trailer style to suggest |
| `hosting` | `auto` | Where the comic goes: `branch`, `attach`, or `auto` |
| `imageConsent` | `[]` | Image services you agreed to (set by `tracetoon images --approve`; user config only) |
| `budgetTokens` | `12000` | Digest size |

### Comic art

`tracetoon comic art` picks the first route you have approved that can draw,
in this order:

| Route | Needs | Prompts go to |
| --- | --- | --- |
| `codex` | the Codex CLI, signed in with ChatGPT (`codex login`) | OpenAI, counted against your Codex usage |
| `antigravity` (experimental) | the Antigravity CLI, signed in | Google, counted against your Antigravity quota |
| `openai` | `OPENAI_API_KEY` (model `gpt-image-2.5-flare`, change with `TRACETOON_OPENAI_MODEL`) | OpenAI, billed to your key |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` (model `gemini-nano-banana-2.1`, change with `TRACETOON_GEMINI_MODEL`) | Google, billed to your key |

Nothing is sent until you agree once per route, with `tracetoon images
--approve <route>` (or the agent's `comic art --provider <route> --consent`).
Only you can approve a route: a repo's `.github/tracetoon.json` can't. Prompts
contain only the comic's scenes and character descriptions. `tracetoon images`
shows which routes exist, whether each can draw, and which you have approved;
`--test` draws one picture to check. To stop using one, remove it from
`imageConsent` with `tracetoon config set imageConsent <list>`, or turn a CLI
route off with `TRACETOON_CODEX_BIN=none` / `TRACETOON_AGY_BIN=none`. With no
approved route, or if a route keeps failing, the PR is published without a
comic.

## Develop

```sh
git clone https://github.com/Tingsters/Showtail ../Showtail   # shared log readers
bun install
bun test
bun run typecheck
bun run bundle      # rebuilds plugin/skills/tracetoon/dist/tracetoon.mjs
```

Tracetoon builds on [`@showtail/agent-traces`](https://github.com/Tingsters/Showtail/tree/main/packages/agent-traces),
the log readers and redaction shared with [Showtail](https://github.com/Tingsters/Showtail).
Until that package is on npm, development expects a Showtail checkout next to
this repo (see `tsconfig.json` paths). See [CONTRIBUTING.md](CONTRIBUTING.md).

Apache-2.0. The bundled Comic Neue font is under the SIL Open Font License
(`plugin/skills/tracetoon/assets/fonts/OFL.txt`).
