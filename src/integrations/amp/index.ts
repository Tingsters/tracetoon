/**
 * Amp (ampcode.com). Its threads are kept on Amp's servers, not on disk, so
 * Tracetoon reads no Amp sessions; it routes PR creation through a plugin in
 * ~/.config/amp/plugins (XDG_CONFIG_HOME) and installs the skill in
 * ~/.agents/skills.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { denyOpencode, parseOpencodePayload } from '../../hook/opencodePlugin.ts';
import { onPath } from '../../util/onPath.ts';
import type { Env, Integration } from '../types.ts';
import { ampPluginCommand, renderAmpPlugin } from './hook.ts';

const configDir = (h: string, env: Env) =>
  join(env.XDG_CONFIG_HOME || join(h, '.config'), 'amp');
const present = (h: string, env: Env) =>
  existsSync(configDir(h, env)) || !!onPath('amp', env);

export const integration: Integration = {
  id: 'amp',
  label: 'Amp',
  status: 'supported',
  traces: [],
  hook: {
    file: (h, env) => join(configDir(h, env), 'plugins', 'tracetoon.ts'),
    present,
    apply: (data) => data,
    installedCommand: () => undefined,
    text: { render: renderAmpPlugin, command: ampPluginCommand },
    parse: (raw) => parseOpencodePayload(raw, 'amp'),
    deny: denyOpencode,
    installNote: () =>
      'In Amp, run "plugins: reload" from the command palette, or start a new session.',
  },
  skill: (h, env) => ({
    present: present(h, env),
    dir: join(h, '.agents', 'skills', 'tracetoon'),
  }),
};
