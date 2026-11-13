/** OpenCode-format session stores (OpenCode, Kilo CLI) read from a real SQLite file. */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { opencodeStoreAdapter } from '../src/trace/opencodeStore.ts';
import { tempDir } from './helpers.ts';

function store(repo: string) {
  const path = join(tempDir(), 'opencode.db');
  const db = new Database(path);
  db.run(
    'create table session (id text primary key, project_id text, parent_id text, directory text, title text, time_created integer, time_updated integer)',
  );
  db.run(
    'create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)',
  );
  db.run(
    'create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)',
  );
  const t = Date.parse('2026-11-13T12:00:00Z');
  db.run('insert into session values (?, ?, ?, ?, ?, ?, ?)', [
    'ses_1',
    'p',
    null,
    repo,
    'Fix add',
    t,
    t + 9000,
  ]);
  db.run('insert into session values (?, ?, ?, ?, ?, ?, ?)', [
    'ses_other',
    'p',
    null,
    '/elsewhere',
    'Other',
    t,
    t + 9000,
  ]);
  db.run('insert into session values (?, ?, ?, ?, ?, ?, ?)', [
    'ses_old',
    'p',
    null,
    repo,
    'Old',
    t - 1e9,
    t - 1e9,
  ]);
  const msg = (id: string, n: number, data: object) =>
    db.run('insert into message values (?, ?, ?, ?, ?)', [
      id,
      'ses_1',
      t + n,
      t + n,
      JSON.stringify(data),
    ]);
  const part = (id: string, m: string, n: number, data: object) =>
    db.run('insert into part values (?, ?, ?, ?, ?, ?)', [
      id,
      m,
      'ses_1',
      t + n,
      t + n,
      JSON.stringify(data),
    ]);
  msg('m1', 0, { role: 'user', model: { modelID: 'big-pickle' } });
  part('p1', 'm1', 1, { type: 'text', text: 'Fix add() and test it.' });
  msg('m2', 2, { role: 'assistant', modelID: 'big-pickle', path: { cwd: repo } });
  part('p2', 'm2', 3, { type: 'step-start' });
  part('p3', 'm2', 4, {
    type: 'tool',
    tool: 'edit',
    state: {
      status: 'completed',
      input: {
        filePath: join(repo, 'calc.py'),
        oldString: '    return a - b',
        newString: '    return a + b',
      },
      time: { start: t + 4 },
    },
  });
  part('p4', 'm2', 5, {
    type: 'tool',
    tool: 'apply_patch',
    state: {
      status: 'completed',
      input: {
        patchText:
          '*** Begin Patch\n*** Add File: test_calc.py\n+assert add(2, 3) == 5\n*** End Patch',
      },
      time: { start: t + 5 },
    },
  });
  part('p5', 'm2', 6, {
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'python test_calc.py' },
      output: 'boom',
      metadata: { exit: 1 },
      time: { start: t + 6 },
    },
  });
  part('p6', 'm2', 7, {
    type: 'tool',
    tool: 'edit',
    state: { status: 'error', input: { filePath: 'x', oldString: 'a', newString: 'b' } },
  });
  part('p7', 'm2', 8, { type: 'text', text: 'Fixed add().' });
  part('p8', 'm2', 9, { type: 'mystery' });
  db.close();
  return { path, t };
}

describe('OpenCode-format store', () => {
  test('discovers sessions for the repo and reads prompts, edits, patches and commands', () => {
    const repo = join(tempDir(), 'repo');
    const { path, t } = store(repo);
    const adapter = opencodeStoreAdapter('opencode', 'OpenCode', () => path);
    expect(adapter.count()).toBe(3);
    const refs = adapter.discover({ roots: [repo], sinceMs: t - 1000 });
    expect(refs.map((r) => r.sessionId)).toEqual(['ses_1']);
    const s = adapter.read(refs[0]!);
    expect(s.title).toBe('Fix add');
    expect(s.records.find((r) => r.kind === 'prompt')).toMatchObject({
      text: 'Fix add() and test it.',
    });
    expect(s.records.filter((r) => r.kind === 'edit')).toMatchObject([
      { removed: ['    return a - b'], added: ['    return a + b'] },
      { added: ['assert add(2, 3) == 5'], created: true },
    ]);
    expect(s.records.find((r) => r.kind === 'command')).toMatchObject({
      cmd: 'python test_calc.py',
      isError: true,
    });
    expect(s.records.find((r) => r.kind === 'assistant')).toMatchObject({
      text: 'Fixed add().',
      model: 'big-pickle',
    });
    expect(s.unknownTypes).toEqual({ mystery: 1 });
  });

  test('a missing store reads as empty', () => {
    const adapter = opencodeStoreAdapter('kilo', 'Kilo CLI', () =>
      join(tempDir(), 'none.db'),
    );
    expect(adapter.home()).toBeUndefined();
    expect(adapter.count()).toBe(0);
    expect(adapter.discover({ roots: ['/r'], sinceMs: 0 })).toEqual([]);
  });
});
