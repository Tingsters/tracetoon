/**
 * Claude Code plugin hint (https://code.claude.com/docs/en/plugins/cli-hints.md):
 * a `<claude-code-hint />` line on stderr, which Claude Code strips from tool
 * output and turns into a one-time "install this plugin" prompt.
 *
 * Off: hints only work for plugins listed in one of Anthropic's official
 * marketplaces, and Tracetoon isn't listed yet. Once it is, set
 * CLAUDE_CODE_HINT_ENABLED to true and HINT_PLUGIN to the listed
 * `name@marketplace` (AGENTS.md, "Claude Code plugin hint").
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_CODE_HINT_ENABLED = false;
export const HINT_PLUGIN = 'tracetoon@claude-plugins-official';

/** Commands that never print the hint: protocol servers and agent hooks. */
const QUIET_COMMANDS = new Set(['mcp', 'hook']);

/** True when Claude Code already has Tracetoon as a plugin or a personal skill. */
export function claudeHasTracetoon(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): boolean {
  const config = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  if (existsSync(join(config, 'skills', 'tracetoon', 'SKILL.md'))) return true;
  try {
    const installed = readFileSync(
      join(config, 'plugins', 'installed_plugins.json'),
      'utf8',
    );
    if (/"tracetoon@[^"]*"/.test(installed)) return true;
  } catch {
    /* no plugins installed */
  }
  try {
    const cache = join(config, 'plugins', 'cache');
    for (const market of readdirSync(cache))
      if (existsSync(join(cache, market, 'tracetoon'))) return true;
  } catch {
    /* no plugin cache */
  }
  // This runtime is itself running from a plugin copy.
  return /[\\/]plugins[\\/]cache[\\/]/.test(env.TRACETOON_LAUNCHER ?? '');
}

/** The hint line to write on stderr for this invocation, if any. */
export function claudeCodeHint(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  enabled = CLAUDE_CODE_HINT_ENABLED,
): string | undefined {
  if (!enabled) return undefined;
  if (!env.CLAUDECODE && !env.CLAUDE_CODE_CHILD_SESSION) return undefined;
  const command = argv.find((a) => !a.startsWith('-'));
  if (command && QUIET_COMMANDS.has(command)) return undefined;
  if (claudeHasTracetoon(env, home)) return undefined;
  return `<claude-code-hint v="1" type="plugin" value="${HINT_PLUGIN}" />\n`;
}
