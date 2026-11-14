/**
 * npm packages made from a verified release artifact set. Nothing is compiled:
 * each platform package carries the exact release binary, and the `tracetoon`
 * wrapper carries a small Node launcher plus the skill from the verified
 * tracetoon-skill.zip. Install scripts are never used (Bun blocks them).
 *
 *   bun .github/scripts/npm-packages.ts <assets> <extracted-skill> <out> [version]
 *
 * prints each package folder in publish order: platform packages, then the wrapper.
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { SUPPORTED_TARGETS, verifyCandidateInputs } from './release-assets.ts';
import rootPkg from '../../package.json';

const ROOT = resolve(import.meta.dir, '../..');
const TEMPLATES = join(import.meta.dir, 'npm');
export const SCOPE = '@tracetoon';
const REPOSITORY = {
  type: 'git',
  url: 'git+https://github.com/Tracetoon/tracetoon.git',
};
const COMMON = {
  license: 'Apache-2.0',
  homepage: 'https://tracetoon.ai',
  repository: REPOSITORY,
  bugs: 'https://github.com/Tracetoon/tracetoon/issues',
  author: 'Tracetoon',
};

/** Release target (build.config.json) → npm `os`/`cpu` and package suffix. */
export function npmPlatform(target: string): { id: string; os: string; cpu: string } {
  const [os, cpu] = target.split('-') as [string, string];
  const npmOs = os === 'windows' ? 'win32' : os;
  if (!['linux', 'darwin', 'win32'].includes(npmOs) || !['x64', 'arm64'].includes(cpu))
    throw Error(`No npm platform for release target ${target}.`);
  return { id: `${npmOs}-${cpu}`, os: npmOs, cpu };
}

export interface NpmPackage {
  name: string;
  dir: string;
}

const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

export function buildNpmPackages(
  assets: string,
  skill: string,
  out: string,
  version?: string,
): NpmPackage[] {
  // The same checks the release ran: exact bytes, receipts, and the extracted skill.
  const manifest = verifyCandidateInputs(assets, skill);
  if (version !== undefined && version !== manifest.version)
    throw Error(`Release assets are ${manifest.version}, not ${version}.`);
  if (existsSync(out) && readdirSync(out).length)
    throw Error(`Output folder ${out} is not empty.`);
  mkdirSync(out, { recursive: true });

  const packages: NpmPackage[] = [];
  for (const target of SUPPORTED_TARGETS) {
    const { id, os, cpu } = npmPlatform(target);
    const exe = os === 'win32' ? '.exe' : '';
    const name = `${SCOPE}/cli-${id}`;
    const dir = join(out, `cli-${id}`);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const binary = join(dir, 'bin', `tracetoon${exe}`);
    copyFileSync(join(assets, `tracetoon-${target}${exe}`), binary);
    chmodSync(binary, 0o755);
    copyFileSync(
      join(assets, `tracetoon-${target}${exe}.build.json`),
      join(dir, 'bin', `tracetoon${exe}.build.json`),
    );
    copyFileSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
    writeFileSync(
      join(dir, 'README.md'),
      `# ${name}\n\nThe prebuilt Tracetoon ${manifest.version} binary for ${id}, from the GitHub release.\n` +
        `Install \`tracetoon\` instead; it picks this package for you: \`npx tracetoon@latest setup\`.\n`,
    );
    writeJson(join(dir, 'package.json'), {
      name,
      version: manifest.version,
      description: `The Tracetoon binary for ${id}. Use the tracetoon package.`,
      ...COMMON,
      os: [os],
      cpu: [cpu],
      files: ['bin/'],
      preferUnplugged: true,
    });
    packages.push({ name, dir });
  }

  const dir = join(out, 'tracetoon');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  copyFileSync(join(TEMPLATES, 'tracetoon.js'), join(dir, 'bin', 'tracetoon.js'));
  chmodSync(join(dir, 'bin', 'tracetoon.js'), 0o755);
  copyFileSync(join(TEMPLATES, 'README.md'), join(dir, 'README.md'));
  copyFileSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
  // The skill exactly as released (verified against the retained inventory above).
  const shipped = join(dir, 'skill', 'tracetoon');
  cpSync(skill, shipped, { recursive: true });
  chmodSync(join(shipped, 'bin', 'tracetoon'), 0o755);
  writeJson(join(dir, 'package.json'), {
    name: 'tracetoon',
    version: manifest.version,
    description:
      'Write pull request descriptions from the AI agent session logs already on your machine. Run: npx tracetoon@latest setup',
    ...COMMON,
    keywords: [
      'pull-request',
      'github',
      'ai-agents',
      'agent-skills',
      'claude-code',
      'codex',
    ],
    // The MCP Registry accepts server.json only when the npm package names it here.
    mcpName: rootPkg.mcpName,
    bin: { tracetoon: 'bin/tracetoon.js' },
    files: ['bin/', 'skill/'],
    engines: { node: '>=18' },
    optionalDependencies: Object.fromEntries(
      packages.map((p) => [p.name, manifest.version]),
    ),
  });
  packages.push({ name: 'tracetoon', dir });
  return packages;
}

if (import.meta.main) {
  const [assets, skill, out, version] = process.argv.slice(2);
  if (!assets || !skill || !out)
    throw Error('Use: npm-packages.ts <assets> <extracted-skill> <out> [version]');
  for (const p of buildNpmPackages(
    resolve(assets),
    resolve(skill),
    resolve(out),
    version,
  ))
    console.log(p.dir);
}
