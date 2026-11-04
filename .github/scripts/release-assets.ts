/** Distribution tooling stays outside runtime build inputs; promoted bytes never change. */
import {
  copyFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildManifest } from '../../scripts/build-info.ts';
export const sha = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const hash = (s: string) => /^[a-f0-9]{64}$/.test(s);
const simple = (s: string) =>
  /^[a-zA-Z0-9._-]+$/.test(s) && basename(s) === s && s !== '.' && s !== '..';
export const SUPPORTED_TARGETS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'windows-x64',
];
export interface AssetManifest {
  schema: 'tracetoon.candidate-artifacts/v1';
  version: string;
  buildId: string;
  sourceRevision: string;
  skillManifestSha256: string;
  bundleSha256: string;
  files: { name: string; sha256: string }[];
  skillFiles: { name: string; sha256: string }[];
}
export interface Promotion {
  schema: 'tracetoon.release-promotion/v1';
  version: string;
  buildId: string;
  artifact: { runId: number; id: number; name: string; digest: string };
  expected: {
    manifestSha256: string;
    checksumsSha256: string;
    windowsSha256: string;
    bundleSha256: string;
  };
  evaluations: {
    split: 'dev' | 'test';
    status: 'passed';
    experiment: string;
    reportSha256: string;
    writers: number;
    orders: number;
  }[];
}
export function skillInventory(
  dir: string,
  prefix = '',
): { name: string; sha256: string }[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => {
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw Error('Candidate skill contains a symbolic link.');
      return e.isDirectory()
        ? skillInventory(dir, name)
        : [{ name, sha256: sha(join(dir, name)) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function writeInventory(
  out: string,
  skill: string,
  sourceRevision: string,
): AssetManifest {
  const manifest = JSON.parse(readFileSync(join(skill, 'build.json'), 'utf8'));
  copyFileSync(join(skill, 'build.json'), join(out, 'skill-build.json'));
  copyFileSync(join(skill, 'dist/tracetoon.mjs'), join(out, 'tracetoon.mjs'));
  copyFileSync(
    join(skill, 'dist/tracetoon.mjs.build.json'),
    join(out, 'tracetoon.mjs.build.json'),
  );
  const files = readdirSync(out)
    .filter((n) => !['candidate-manifest.json', 'checksums.txt'].includes(n))
    .sort()
    .map((name) => {
      if (!simple(name) || !lstatSync(join(out, name)).isFile())
        throw Error('Candidate assets must be regular files with simple names.');
      return { name, sha256: sha(join(out, name)) };
    });
  const inventory: AssetManifest = {
    schema: 'tracetoon.candidate-artifacts/v1',
    version: manifest.version,
    buildId: manifest.buildId,
    sourceRevision,
    skillManifestSha256: sha(join(skill, 'build.json')),
    bundleSha256: sha(join(skill, 'dist/tracetoon.mjs')),
    files,
    skillFiles: skillInventory(skill),
  };
  writeFileSync(
    join(out, 'candidate-manifest.json'),
    JSON.stringify(inventory, null, 2) + '\n',
  );
  writeFileSync(
    join(out, 'checksums.txt'),
    [
      ...files,
      {
        name: 'candidate-manifest.json',
        sha256: sha(join(out, 'candidate-manifest.json')),
      },
    ]
      .map((f) => `${f.sha256}  ${f.name}`)
      .join('\n') + '\n',
  );
  verifyAssets(out);
  return inventory;
}
export function verifyAssets(out: string): AssetManifest {
  const manifest: AssetManifest = JSON.parse(
    readFileSync(join(out, 'candidate-manifest.json'), 'utf8'),
  );
  const skill = JSON.parse(readFileSync(join(out, 'skill-build.json'), 'utf8'));
  if (
    manifest.schema !== 'tracetoon.candidate-artifacts/v1' ||
    !hash(manifest.buildId) ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceRevision) ||
    skill.buildId !== manifest.buildId ||
    skill.version !== manifest.version ||
    skill.protocol !== 2 ||
    sha(join(out, 'skill-build.json')) !== manifest.skillManifestSha256
  )
    throw Error('Candidate source identity is invalid.');
  if (
    !Array.isArray(skill.recipe?.native?.targets) ||
    JSON.stringify([...skill.recipe.native.targets].sort()) !==
      JSON.stringify([...SUPPORTED_TARGETS].sort())
  )
    throw Error('Candidate platform set differs from the release protocol.');
  if (
    !Array.isArray(manifest.skillFiles) ||
    manifest.skillFiles.some(
      (f) =>
        !f.name ||
        f.name.startsWith('/') ||
        f.name.includes('\\') ||
        f.name.includes(':') ||
        f.name.split('/').includes('..') ||
        !hash(f.sha256),
    ) ||
    new Set(manifest.skillFiles.map((f) => f.name)).size !== manifest.skillFiles.length ||
    !['SKILL.md', 'VERSION', 'build.json', 'dist/tracetoon.mjs'].every((n) =>
      manifest.skillFiles.some((f) => f.name === n),
    )
  )
    throw Error('Candidate skill inventory is invalid.');
  if (
    !Array.isArray(manifest.files) ||
    new Set(manifest.files.map((f) => f.name)).size !== manifest.files.length
  )
    throw Error('Candidate file inventory is invalid.');
  for (const file of manifest.files)
    if (
      !simple(file.name) ||
      !hash(file.sha256) ||
      !lstatSync(join(out, file.name)).isFile() ||
      sha(join(out, file.name)) !== file.sha256
    )
      throw Error(`Candidate asset checksum mismatch: ${file.name}`);
  const actual = readdirSync(out).sort(),
    wanted = [
      ...manifest.files.map((f) => f.name),
      'candidate-manifest.json',
      'checksums.txt',
    ].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    throw Error('Candidate asset inventory contains missing or unexpected files.');
  const sums = readFileSync(join(out, 'checksums.txt'), 'utf8').trim().split(/\r?\n/);
  const expected = [
    ...manifest.files,
    {
      name: 'candidate-manifest.json',
      sha256: sha(join(out, 'candidate-manifest.json')),
    },
  ];
  if (
    sums.length !== expected.length ||
    expected.some((f) => !sums.includes(`${f.sha256}  ${f.name}`))
  )
    throw Error('Candidate checksums file is invalid.');
  if (sha(join(out, 'tracetoon.mjs')) !== manifest.bundleSha256)
    throw Error('Candidate bundle checksum mismatch.');
  for (const target of skill.recipe.native.targets as string[]) {
    const name = `tracetoon-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
    const receipt = JSON.parse(readFileSync(join(out, `${name}.build.json`), 'utf8'));
    if (
      receipt.schema !== 'tracetoon.build-output/v1' ||
      receipt.target !== target ||
      receipt.buildId !== manifest.buildId ||
      receipt.inputManifestSha256 !== manifest.skillManifestSha256 ||
      receipt.sha256 !== sha(join(out, name)) ||
      receipt.compiler?.version !== skill.compiler.version ||
      !hash(receipt.compiler?.sha256 ?? '')
    )
      throw Error(`Candidate output receipt is invalid: ${target}`);
    if (!manifest.files.some((f) => f.name === `tracetoon-skill-${target}.zip`))
      throw Error('Candidate platform skill archive is missing.');
  }
  if (!manifest.files.some((f) => f.name === 'tracetoon-skill.zip'))
    throw Error('Candidate slim skill archive is missing.');
  const bundle = JSON.parse(readFileSync(join(out, 'tracetoon.mjs.build.json'), 'utf8'));
  if (
    bundle.schema !== 'tracetoon.build-output/v1' ||
    bundle.target !== 'node-esm' ||
    bundle.buildId !== manifest.buildId ||
    bundle.inputManifestSha256 !== manifest.skillManifestSha256 ||
    bundle.sha256 !== manifest.bundleSha256 ||
    bundle.compiler?.version !== skill.compiler.version ||
    !hash(bundle.compiler?.sha256 ?? '')
  )
    throw Error('Candidate bundle receipt is invalid.');
  return manifest;
}
export function verifyCandidateInputs(out: string, skill?: string, revision?: string) {
  const manifest = verifyAssets(out);
  if (revision && manifest.sourceRevision !== revision)
    throw Error('Candidate source differs from the requested revision.');
  if (
    skill &&
    JSON.stringify(skillInventory(skill)) !== JSON.stringify(manifest.skillFiles)
  )
    throw Error('Extracted candidate skill differs from the retained inventory.');
  return manifest;
}
export function validatePromotion(p: Promotion) {
  if (
    p.schema !== 'tracetoon.release-promotion/v1' ||
    !hash(p.buildId) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(p.version) ||
    !Number.isSafeInteger(p.artifact?.runId) ||
    p.artifact.runId <= 0 ||
    !Number.isSafeInteger(p.artifact.id) ||
    p.artifact.id <= 0 ||
    !simple(p.artifact.name) ||
    !/^sha256:[a-f0-9]{64}$/.test(p.artifact.digest)
  )
    throw Error('Release promotion identity is invalid.');
  if (!p.expected || Object.values(p.expected).some((v) => !hash(v)))
    throw Error('Release promotion hashes are invalid.');
  if (p.evaluations?.length !== 2) throw Error('Both adoption evaluations are required.');
  for (const [split, writers, orders] of [
    ['dev', 90, 240],
    ['test', 36, 96],
  ] as const) {
    const evaluation = p.evaluations.filter((e) => e.split === split);
    if (
      evaluation.length !== 1 ||
      evaluation[0]!.status !== 'passed' ||
      evaluation[0]!.writers !== writers ||
      evaluation[0]!.orders !== orders ||
      !hash(evaluation[0]!.experiment) ||
      !hash(evaluation[0]!.reportSha256)
    )
      throw Error(`Passing ${split} adoption evidence is required.`);
  }
}
export function verifyArtifactMetadata(metadata: any, p: Promotion) {
  validatePromotion(p);
  if (
    metadata.id !== p.artifact.id ||
    metadata.name !== p.artifact.name ||
    metadata.digest !== p.artifact.digest ||
    metadata.expired !== false ||
    metadata.workflow_run?.id !== p.artifact.runId
  )
    throw Error('GitHub artifact identity differs from the promotion record.');
}
export function verifyPromotion(
  out: string,
  p: Promotion,
  source: { version: string; buildId: string },
  tag: string,
) {
  validatePromotion(p);
  const assets = verifyAssets(out);
  if (
    tag !== `v${p.version}` ||
    assets.version !== p.version ||
    source.version !== p.version ||
    assets.buildId !== p.buildId ||
    source.buildId !== p.buildId
  )
    throw Error('Release tag/source differs from the evaluated candidate.');
  if (
    sha(join(out, 'candidate-manifest.json')) !== p.expected.manifestSha256 ||
    sha(join(out, 'checksums.txt')) !== p.expected.checksumsSha256 ||
    assets.bundleSha256 !== p.expected.bundleSha256 ||
    sha(join(out, 'tracetoon-windows-x64.exe')) !== p.expected.windowsSha256
  )
    throw Error('Release bytes differ from the evaluated candidate.');
  return assets;
}
if (import.meta.main) {
  const [mode, dir, promotionPath, tag] = process.argv.slice(2);
  if (mode === 'inventory')
    writeInventory(
      resolve(dir!),
      resolve(import.meta.dir, '../../plugin/skills/tracetoon'),
      process.env.TRACETOON_BUILD_REVISION ??
        process.env.GITHUB_SHA ??
        Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
    );
  else if (mode === 'assets') {
    const assets = verifyCandidateInputs(
      resolve(dir!),
      promotionPath ? resolve(promotionPath) : undefined,
      process.env.TRACETOON_BUILD_REVISION,
    );
    console.log(
      JSON.stringify({
        version: assets.version,
        buildId: assets.buildId,
        sourceRevision: assets.sourceRevision,
        windowsSha256: sha(join(resolve(dir!), 'tracetoon-windows-x64.exe')),
      }),
    );
  } else if (mode === 'verify') {
    const p: Promotion = JSON.parse(readFileSync(resolve(promotionPath!), 'utf8'));
    const assets = verifyPromotion(resolve(dir!), p, buildManifest(false, false), tag!);
    if (
      Bun.spawnSync(['git', 'merge-base', '--is-ancestor', assets.sourceRevision, 'HEAD'])
        .exitCode !== 0
    )
      throw Error('Candidate source is not an ancestor of the release commit.');
    console.log(`Verified promotion ${tag}; exact evaluated bytes retained.`);
  } else if (mode === 'artifact') {
    verifyArtifactMetadata(
      JSON.parse(readFileSync(resolve(dir!), 'utf8')),
      JSON.parse(readFileSync(resolve(promotionPath!), 'utf8')),
    );
  } else if (mode === 'metadata') {
    const p: Promotion = JSON.parse(readFileSync(resolve(dir!), 'utf8'));
    validatePromotion(p);
    const values = {
      runId: String(p.artifact.runId),
      artifactId: String(p.artifact.id),
      artifactDigest: p.artifact.digest,
    };
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(values)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n') + '\n',
        { flag: 'a' },
      );
    else console.log(JSON.stringify(values));
  } else
    throw Error(
      'Use inventory <assets>, assets <assets> [skill], metadata <promotion>, or verify <assets> <promotion> <tag>.',
    );
}
