/**
 * Install a release over the current one, the way install.sh does: everything is
 * downloaded and checked before anything is replaced, and a failed step puts the
 * previous files back.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { skillInstalls } from '../commands/doctor.ts';
import { run } from '../util/exec.ts';
import { fetchBytes, fetchText, sources, type Release } from './release.ts';
import type { Layout } from './layout.ts';

export interface Applied {
  tag: string;
  binary: string;
  skills: { agent: string; dir: string }[];
  hooks: boolean;
}

/**
 * Remove leftovers. Never throws: once files are swapped in, a leftover that cannot
 * be deleted (on Windows, the old running binary) must not undo or fail the update.
 */
function discard(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* the next update clears it */
  }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function wantedHash(checksums: string, file: string): string | undefined {
  for (const line of checksums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *]?(.+)$/i.exec(line.trim());
    if (m && m[2] === file) return m[1]!.toLowerCase();
  }
  return undefined;
}

/** Unpack a zip with whatever the machine has (Windows 10+ and macOS ship a bsdtar). */
export function unzip(zip: string, dir: string): void {
  const tools: [string, string[]][] = [
    ['unzip', ['-q', zip, '-d', dir]],
    ['bsdtar', ['-xf', zip, '-C', dir]],
    ['tar', ['-xf', zip, '-C', dir]],
    ['python3', ['-m', 'zipfile', '-e', zip, dir]],
    ['python', ['-m', 'zipfile', '-e', zip, dir]],
  ];
  for (const [cmd, args] of tools) if (run(cmd, args).ok) return;
  throw new Error('need unzip, bsdtar or python3 to unpack the skill');
}

/** Swap `target` for `stage`, keeping the old one aside until the move has worked. */
function swapDir(stage: string, target: string, tag: string): () => void {
  const backup = `${target}.old-${tag}`;
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, backup);
  try {
    renameSync(stage, target);
  } catch (e) {
    if (existsSync(backup)) renameSync(backup, target);
    throw e;
  }
  // Undo, or (once everything worked) discard the old copy.
  return () => {
    if (existsSync(backup)) {
      rmSync(target, { recursive: true, force: true });
      renameSync(backup, target);
    }
  };
}

/** Where the new binary is staged before the swap: `tracetoon.new-<id>.exe` on Windows. */
export function stagedBinary(stable: string, id: string): string {
  const ext = /\.exe$/i.exec(stable)?.[0] ?? '';
  return `${stable.slice(0, stable.length - ext.length)}.new-${id}${ext}`;
}

export async function applyRelease(
  release: Release,
  layout: Layout,
  home: string,
  env: NodeJS.ProcessEnv,
  /** Called after each part is swapped in; tests throw from it to exercise the undo. */
  afterSwap?: (part: 'binary' | 'assets' | 'skill') => void,
): Promise<Applied> {
  const src = sources(env);
  const tmp = mkdtempSync(join(tmpdir(), 'tracetoon-update-'));
  const id = String(process.pid);
  const staged: string[] = [];
  const undo: (() => void)[] = [];
  try {
    // 1. Download and verify.
    const checksums = await fetchText(src.download(release.tag, 'checksums.txt'));
    const files: Record<string, string> = {};
    for (const file of ['tracetoon-skill.zip', layout.asset]) {
      const bytes = await fetchBytes(src.download(release.tag, file));
      const want = wantedHash(checksums, file);
      if (!want || want !== sha256(bytes))
        throw new Error(`checksum mismatch for ${file}; nothing was changed`);
      files[file] = join(tmp, file);
      writeFileSync(files[file], bytes);
    }

    // 2. The skill and the runtime must be one build.
    const skillRoot = join(tmp, 'skill');
    mkdirSync(skillRoot);
    unzip(files['tracetoon-skill.zip']!, skillRoot);
    const skill = join(skillRoot, 'tracetoon');
    if (!existsSync(join(skill, 'SKILL.md')))
      throw new Error('skill archive is missing SKILL.md');
    const version = readFileSync(join(skill, 'VERSION'), 'utf8').trim();
    if (version !== release.version)
      throw new Error(`skill version ${version} does not match release ${release.tag}`);
    const build = JSON.parse(readFileSync(join(skill, 'build.json'), 'utf8')).buildId;
    const binary = files[layout.asset]!;
    chmodSync(binary, 0o755);
    try {
      chmodSync(join(skill, 'bin', 'tracetoon'), 0o755);
    } catch {
      /* Windows has no execute bit */
    }
    const info = run(binary, ['build-info', '--json']);
    let got: unknown;
    try {
      got = JSON.parse(info.stdout).buildId;
    } catch {
      /* reported below */
    }
    if (!info.ok)
      throw new Error('the downloaded runtime does not run; nothing was changed');
    if (!build || got !== build)
      throw new Error('skill and runtime builds differ; nothing was changed');

    // 3. Stage a copy of the skill beside every place it is installed, and of the assets.
    const targets = skillInstalls(home, env).map((s) => ({ agent: s.agent, dir: s.dir }));
    for (const t of targets) {
      const stage = `${t.dir}.new-${id}`;
      rmSync(stage, { recursive: true, force: true });
      cpSync(skill, stage, { recursive: true });
      staged.push(stage);
    }
    const assetsStage = `${layout.assets}.new-${id}`;
    rmSync(assetsStage, { recursive: true, force: true });
    mkdirSync(dirname(assetsStage), { recursive: true });
    cpSync(join(skill, 'assets'), assetsStage, { recursive: true });
    staged.push(assetsStage);

    // 4. Replace. A rename keeps a running hook's binary intact on Unix; Windows
    //    refuses to overwrite a loaded exe but allows a rename, so set the old one aside.
    mkdirSync(dirname(layout.stable), { recursive: true });
    // Keep the extension last: Windows (and Bun's spawn there) runs only names ending in .exe.
    const next = stagedBinary(layout.stable, id);
    copyFileSync(binary, next);
    chmodSync(next, 0o755);
    if (!run(next, ['--version']).ok)
      throw new Error('the downloaded binary does not run');
    const aside = `${layout.stable}.old-${id}`;
    discard(aside);
    if (existsSync(layout.stable)) renameSync(layout.stable, aside);
    try {
      renameSync(next, layout.stable);
    } catch (e) {
      if (existsSync(aside)) renameSync(aside, layout.stable);
      throw e;
    }
    undo.push(() => {
      if (existsSync(aside)) {
        rmSync(layout.stable, { force: true });
        renameSync(aside, layout.stable);
      }
    });

    afterSwap?.('binary');
    undo.push(swapDir(assetsStage, layout.assets, id));
    afterSwap?.('assets');
    for (const [i, t] of targets.entries()) {
      undo.push(swapDir(staged[i]!, t.dir, id));
      afterSwap?.('skill');
    }

    // 5. Everything is in place: discard the old copies and register the hooks again.
    for (const t of targets) discard(`${t.dir}.old-${id}`);
    discard(`${layout.assets}.old-${id}`);
    discard(aside); // Windows keeps the old running binary locked; the next update clears it
    const hooks = run(layout.stable, ['hook', 'install'], { env }).ok;
    // Everything is installed by now: a receipt that cannot be written must not undo that.
    try {
      writeFileSync(
        layout.receipt,
        JSON.stringify(
          {
            method: 'installer',
            version: release.version,
            tag: release.tag,
            updatedAt: new Date().toISOString(),
            path: layout.stable,
          },
          null,
          2,
        ) + '\n',
      );
    } catch {
      /* informational only */
    }
    return { tag: release.tag, binary: layout.stable, skills: targets, hooks };
  } catch (e) {
    for (const u of undo.reverse())
      try {
        u();
      } catch {
        /* keep restoring the rest */
      }
    throw e;
  } finally {
    for (const s of staged) discard(s);
    discard(stagedBinary(layout.stable, id));
    discard(tmp);
  }
}
