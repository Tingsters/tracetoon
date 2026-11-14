/**
 * OpenCode: ~/.local/share/opencode/opencode.db (XDG_DATA_HOME, or OPENCODE_DB for the file),
 * plugins in ~/.config/opencode/plugins (XDG_CONFIG_HOME).
 *
 * Both the session store and the plugin hook use the shared OpenCode-format
 * helpers in src/trace/opencodeStore.ts and src/hook/opencodePlugin.ts. The
 * plugin file is Tracetoon's own; skills are read from ~/.agents/skills.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  denyOpencode,
  opencodePluginCommand,
  parseOpencodePayload,
  renderOpencodePlugin,
} from '../../hook/opencodePlugin.ts';
import { opencodeStoreAdapter } from '../../trace/opencodeStore.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, Integration } from '../types.ts';

const dataDir = (h: string, env: Env) =>
  join(env.XDG_DATA_HOME || join(h, '.local', 'share'), 'opencode');
const configDir = (h: string, env: Env) =>
  join(env.XDG_CONFIG_HOME || join(h, '.config'), 'opencode');
const dbPath = (env: Env = process.env) =>
  env.OPENCODE_DB || join(dataDir(homedir(), env), 'opencode.db');

export const integration: Integration = {
  id: 'opencode',
  label: 'OpenCode',
  status: 'supported',
  variants: 'CLI',
  traces: [opencodeStoreAdapter('opencode', 'OpenCode', () => dbPath())],
  hook: {
    file: (h, env) => join(configDir(h, env), 'plugins', 'tracetoon.js'),
    present: (h, env) => existsSync(dataDir(h, env)) || existsSync(configDir(h, env)),
    text: {
      render: (commands) => renderOpencodePlugin('opencode', commands),
      command: opencodePluginCommand,
    },
    apply: (data) => data,
    installedCommand: () => undefined,
    parse: (raw) => parseOpencodePayload(raw, 'opencode'),
    deny: denyOpencode,
  },
  skill: (h, env) => ({
    present: existsSync(configDir(h, env)) || !!onPath('opencode', env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
};
