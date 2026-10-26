/** Stamp one identity into the skill, bundle and compiled binaries. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
export function buildManifest(check = false) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    .version as string;
  const pluginPath = join(root, 'plugin/.claude-plugin/plugin.json');
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
  if (check && plugin.version !== version)
    throw new Error('Plugin version differs from package.json. Run bun run bundle.');
  if (!check)
    writeFileSync(pluginPath, JSON.stringify({ ...plugin, version }, null, 2) + '\n');
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${e.name}`;
      if (['build.json', 'VERSION'].includes(e.name) || path.includes('/dist/')) continue;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) paths.push(path);
    }
  };
  for (const dir of ['src', 'scripts', 'plugin/skills/tracetoon']) walk(dir);
  paths.push(
    'package.json',
    'bun.lock',
    'install.sh',
    'install.ps1',
    'plugin/.claude-plugin/plugin.json',
  );
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const data = readFileSync(join(root, path));
    const text = data.toString('utf8');
    hash
      .update(path)
      .update('\0')
      .update(
        !data.includes(0) && Buffer.from(text).equals(data)
          ? text.replace(/\r\n/g, '\n')
          : data,
      )
      .update('\0');
  }
  const manifest = {
    version,
    buildId: hash.digest('hex'),
    revision: process.env.TRACETOON_BUILD_REVISION ?? process.env.GITHUB_SHA ?? null,
    protocol: 1,
  };
  const file = join(root, 'plugin/skills/tracetoon/build.json');
  if (check) {
    const old = JSON.parse(readFileSync(file, 'utf8'));
    if (
      old.version !== version ||
      old.buildId !== manifest.buildId ||
      readFileSync(join(root, 'plugin/skills/tracetoon/VERSION'), 'utf8').trim() !==
        version
    )
      throw new Error(
        'Build identity is stale. Run bun run bundle after finalizing source and skill changes.',
      );
  } else {
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(root, 'plugin/skills/tracetoon/VERSION'), version + '\n');
  }
  return manifest;
}
if (import.meta.main) console.log(buildManifest(process.argv.includes('--check')));
