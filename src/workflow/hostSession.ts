/** Small private registry linking host sessions to the repositories they actually touch. */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { userConfigPath } from '../config.ts';
import { readLocal, writeLocal } from '../util/localJson.ts';

export interface HostSession {
  v: 1;
  repos: { root: string; baseline: string }[];
  recoveries: Record<string, number>;
  transcript?: string;
}
const path = (id: string) =>
  join(
    dirname(userConfigPath()),
    'host-sessions',
    `${createHash('sha256').update(id).digest('hex')}.json`,
  );
export function readHost(id: string): HostSession {
  return readLocal<HostSession>(path(id)) ?? { v: 1, repos: [], recoveries: {} };
}
export function saveHost(id: string, value: HostSession) {
  writeLocal(path(id), value);
}
export function rememberRepository(
  id: string,
  root: string,
  baseline: string,
  transcript?: string,
) {
  const value = readHost(id);
  if (!value.repos.some((r) => r.root === root)) value.repos.push({ root, baseline });
  if (transcript) value.transcript = transcript;
  value.repos = value.repos.slice(-20);
  saveHost(id, value);
}
export function acknowledgeRepository(id: string, root: string, baseline: string) {
  const value = readHost(id);
  const entry = value.repos.find((r) => r.root === root);
  if (entry) entry.baseline = baseline;
  else value.repos.push({ root, baseline });
  saveHost(id, value);
}
