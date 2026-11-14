# tracetoon

Tracetoon writes GitHub pull request descriptions from the session logs coding
agents already keep on disk, checks every claim against that evidence, and can
add a one-off comic. This package runs the prebuilt `tracetoon` binary for your
platform and ships the Tracetoon agent skill.

## For agents

```sh
npx tracetoon@latest setup            # install the skill into every agent found, add the PR hook
npx tracetoon@latest doctor --json    # check git, gh and the install
```

`setup --json` reports what it installed; restart the agent afterwards. For a
lasting `tracetoon` command (and a PR hook that outlives the npx cache), install
it globally: `npm install -g tracetoon`, then `tracetoon setup`.

Every command accepts `--json`; `tracetoon commands --json` lists them all.

- Install routes for each agent host:
  https://github.com/Tracetoon/tracetoon/blob/main/docs/agents/install.md
- How agents use Tracetoon:
  https://github.com/Tracetoon/tracetoon/blob/main/AGENTS.md

Needs `git` and the GitHub CLI (`gh`), signed in. Prebuilt binaries: Linux and
macOS (x64, arm64), Windows x64. The binary comes from an optional dependency
(`@tracetoon/cli-<platform>-<arch>`), so don't install with `--omit=optional`.

Apache-2.0. Source and releases: https://github.com/Tracetoon/tracetoon
