/** Explicit verification receipts; raw output and environment values are never persisted. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { contentFingerprint } from './state.ts';
import { readLocal, writeLocal } from '../util/localJson.ts';
import type { Run } from '../run.ts';
import type { Run as EvidenceRun } from '../digest/build.ts';
import { makeScrubber } from '../digest/sanitize.ts';
import { publicationLock } from './publication.ts';
import { readSubmittedFile, repoPath } from '../util/repoFiles.ts';

export interface CheckReceipt {
  v: 1;
  name: string;
  command: string[];
  cwd: string;
  kind: EvidenceRun['kind'];
  fingerprint: string;
  environment: string;
  outcome: 'passed' | 'failed' | 'not-run' | 'running';
  exitCode: number | null;
  reason?: string;
  summary: string[];
  startedAt: string;
  durationMs: number;
  commandSha256?: string;
  inputs?: string[];
}
export const receipts = (run: Run): CheckReceipt[] =>
  readLocal<CheckReceipt[]>(join(run.dir, 'checks.json')) ?? [];
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function inputFingerprint(
  root: string,
  inputs: string[],
  content = contentFingerprint(root),
): string {
  if (!inputs.length) return content;
  return hash([
    content,
    [...new Set(inputs)].sort().map((path) => {
      if (!repoPath(path))
        throw new Error(
          'Extra validation inputs must be public worktree-relative files.',
        );
      return [
        path,
        createHash('sha256').update(readSubmittedFile(root, path)).digest('hex'),
      ];
    }),
  ]);
}
export function checkEnvironment(): string {
  // Hash, don't log, the environment. Changed PATH/toolchain/options invalidate reuse.
  return hash([
    process.platform,
    process.arch,
    process.version,
    (globalThis as { Bun?: { version: string } }).Bun?.version ?? null,
    Object.entries(process.env)
      // Codex changes this correlation id for every shell invocation. It does
      // not change the code, toolchain or user-selected test environment.
      .filter(
        ([k]) => !/^(TRACETOON|FAKE_|_|CODEX_TOOL_CALL_ID$|PWD$|OLDPWD$|SHLVL$)/.test(k),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
export function checkKind(command: string): EvidenceRun['kind'] {
  if (/typecheck|\btsc\b/i.test(command)) return 'typecheck';
  if (/lint|prettier/i.test(command)) return 'lint';
  if (/\btest|pytest|vitest/i.test(command)) return 'test';
  if (/build|bundle|compile/i.test(command)) return 'build';
  if (/\beval/i.test(command)) return 'eval';
  return 'other';
}
interface CheckOptions {
  name: string;
  cwd?: string;
  command: string[];
  skip?: string;
  force?: boolean;
  onStart?: () => void;
  input?: string[];
}
export function executeCheck(
  root: string,
  run: Run,
  opts: CheckOptions,
): CheckReceipt & { reused?: boolean } {
  return publicationLock(run, () => executeUnlocked(root, run, opts), 'checks.lock');
}
function executeUnlocked(
  root: string,
  run: Run,
  opts: CheckOptions,
): CheckReceipt & { reused?: boolean } {
  const cwd = resolve(root, opts.cwd ?? '.');
  const rel = relative(root, cwd).replace(/\\/g, '/');
  if (
    rel === '..' ||
    rel.startsWith('../') ||
    resolve(root, rel) !== cwd ||
    !existsSync(cwd)
  )
    throw new Error('Check directory must be inside this worktree.');
  if (!opts.name.trim() || (!opts.command.length && !opts.skip?.trim()))
    throw new Error('Supply a check command or an explicit --skip reason.');
  const fingerprint = inputFingerprint(root, opts.input ?? []);
  const environment = checkEnvironment();
  const safeName = makeScrubber([root]).text(opts.name);
  const previous = receipts(run);
  const old = previous.find((c) => c.name === safeName);
  if (
    !opts.force &&
    old?.outcome === 'passed' &&
    old.fingerprint === fingerprint &&
    old.environment === environment &&
    old.cwd === rel &&
    (old.commandSha256 ?? hash(old.command)) === hash(opts.command) &&
    !opts.skip
  )
    return { ...old, reused: true };
  opts.onStart?.();
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const scrub = makeScrubber([root]);
  const running: CheckReceipt = {
    v: 1,
    name: safeName,
    command: opts.command.map((c) => scrub.text(c)),
    commandSha256: hash(opts.command),
    cwd: rel,
    kind: checkKind(`${opts.name} ${opts.command.join(' ')}`),
    fingerprint,
    inputs: opts.input,
    environment,
    outcome: 'running',
    exitCode: null,
    summary: [],
    startedAt,
    durationMs: 0,
  };
  writeLocal(join(run.dir, 'checks.json'), [
    ...previous.filter((c) => c.name !== safeName),
    running,
  ]);
  const result = opts.skip
    ? undefined
    : spawnSync(opts.command[0]!, opts.command.slice(1), {
        cwd,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
  if (result?.stdout) process.stderr.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  const after = inputFingerprint(root, opts.input ?? []);
  const receipt: CheckReceipt = {
    v: 1,
    name: safeName,
    command: opts.command.map((c) => scrub.text(c)),
    commandSha256: hash(opts.command),
    cwd: rel,
    kind: checkKind(`${opts.name} ${opts.command.join(' ')}`),
    fingerprint,
    inputs: opts.input,
    environment,
    outcome: opts.skip
      ? 'not-run'
      : result?.status === 0 && !result.error && after === fingerprint
        ? 'passed'
        : 'failed',
    exitCode: result?.status ?? null,
    reason:
      scrub.text(
        opts.skip ??
          (after !== fingerprint
            ? 'The command changed validation inputs; run checks after finalizing those changes.'
            : (result?.error?.message ?? '')),
      ) || undefined,
    summary: makeScrubber([root])
      .text(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`)
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .filter((s) =>
        /\b\d+\s+(?:pass|fail|tests?|checks?)\b|\b(?:Tests|Test Files):/.test(s),
      )
      .slice(-3)
      .map((s) => s.slice(0, 200)),
    startedAt,
    durationMs: Math.round(performance.now() - start),
  };
  writeLocal(join(run.dir, 'checks.json'), [
    ...previous.filter((c) => c.name !== safeName),
    receipt,
  ]);
  return receipt;
}
export function checkReport(root: string, run: Run) {
  const fingerprint = contentFingerprint(root);
  const environment = checkEnvironment();
  return receipts(run).map((c) => ({
    ...c,
    current: (() => {
      try {
        return (
          c.fingerprint === inputFingerprint(root, c.inputs ?? [], fingerprint) &&
          c.environment === environment
        );
      } catch {
        return false;
      }
    })(),
  }));
}
export function receiptEvidence(root: string, run: Run): EvidenceRun[] {
  return checkReport(root, run)
    .filter((c) => c.current && ['passed', 'failed'].includes(c.outcome))
    .map((c, i) => ({
      id: `V${i + 1}`,
      cmd: c.command.join(' '),
      kind: c.kind,
      outcome: c.outcome as 'passed' | 'failed',
      basis: 'exit status',
      summary: c.summary,
      t: c.startedAt,
      revision: 'no later edits seen',
      verificationBasis: 'exact-content-receipt',
    }));
}
