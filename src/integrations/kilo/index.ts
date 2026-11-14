/**
 * Kilo CLI, built on OpenCode: ~/.local/share/kilo/kilo.db (XDG_DATA_HOME, or KILO_DB for
 * the file), plugins in ~/.config/kilo/plugins (XDG_CONFIG_HOME).
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
  join(env.XDG_DATA_HOME || join(h, '.local', 'share'), 'kilo');
const configDir = (h: string, env: Env) =>
  join(env.XDG_CONFIG_HOME || join(h, '.config'), 'kilo');
const dbPath = (env: Env = process.env) =>
  env.KILO_DB || join(dataDir(homedir(), env), 'kilo.db');

export const integration: Integration = {
  id: 'kilo',
  label: 'Kilo CLI',
  status: 'supported',
  variants: 'CLI, and Kilo Code for VS Code, which runs it',
  traces: [opencodeStoreAdapter('kilo', 'Kilo CLI', () => dbPath())],
  hook: {
    file: (h, env) => join(configDir(h, env), 'plugins', 'tracetoon.js'),
    present: (h, env) => existsSync(dataDir(h, env)) || existsSync(configDir(h, env)),
    text: {
      render: (commands) => renderOpencodePlugin('kilo', commands),
      command: opencodePluginCommand,
    },
    apply: (data) => data,
    installedCommand: () => undefined,
    parse: (raw) => parseOpencodePayload(raw, 'kilo'),
    deny: denyOpencode,
  },
  skill: (h, env) => ({
    present: existsSync(configDir(h, env)) || !!onPath('kilo', env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
};
