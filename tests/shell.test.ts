import { describe, expect, test } from 'bun:test';
import { commandKey, isTestCommand, testSegment } from '../src/digest/build.ts';
import { splitCommands } from '../src/util/shell.ts';

describe('splitting command lines', () => {
  test('splits chains and pipes', () => {
    expect(splitCommands('cd x && bun test | tail -3; echo done || true')).toEqual([
      'cd x',
      'bun test',
      'tail -3',
      'echo done',
      'true',
    ]);
  });

  test('leaves quoted scripts alone', () => {
    const py = `python -c "\nfor c in cmds:\n  if 'bun test' in c: print(c)\n"; git status`;
    expect(splitCommands(py)).toEqual([py.split('; ')[0]!, 'git status']);
    expect(splitCommands(`echo 'a; b | c' && ls`)).toEqual([`echo 'a; b | c'`, 'ls']);
    expect(splitCommands('echo "say \\"hi; there\\"" ; ls')).toEqual([
      'echo "say \\"hi; there\\""',
      'ls',
    ]);
  });

  test('skips heredoc bodies, but not what follows them', () => {
    const cmd =
      "cat > notes.md <<'EOF'\nbun test\nnpm test; rm -rf /\nEOF\nbun test tests/x.test.ts";
    expect(splitCommands(cmd)).toEqual([
      "cat > notes.md <<'EOF'",
      'bun test tests/x.test.ts',
    ]);
    expect(splitCommands('python - <<PY | tail -2\nprint(1)\nPY')).toEqual([
      'python - <<PY',
      'tail -2',
    ]);
  });
});

describe('test commands', () => {
  test('a test runner named only inside a quoted script is not a test run', () => {
    expect(isTestCommand(`python -c "\nif c['cmd'] == 'bun test': print(1)\n"`)).toBe(
      false,
    );
    expect(isTestCommand("cat > a.md <<'EOF'\nbun test\nEOF")).toBe(false);
    expect(
      testSegment('bun x tsc --noEmit && bun test > /tmp/log 2>&1; grep pass /tmp/log'),
    ).toBe('bun test > /tmp/log 2>&1');
  });

  test('grouping keys come from the real first command', () => {
    expect(commandKey(`cd repo && python - <<'PY'\nimport json\nPY`)).toBe('python');
  });
});
