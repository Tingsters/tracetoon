#!/usr/bin/env node
// Tracetoon npm wrapper. npm installed the prebuilt binary for this machine as
// an optional dependency (@tracetoon/cli-<platform>-<arch>); this runs it with
// the skill this package ships, and passes the exit code and signals through.
// No dependencies and no install scripts: runs under Node 18+ and Bun.
'use strict';

const { spawn } = require('child_process');
const { chmodSync, existsSync, statSync } = require('fs');
const path = require('path');

const SUPPORTED = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
const DOCS = 'https://github.com/Tracetoon/tracetoon/blob/main/docs/agents/install.md';

function fail(lines) {
  process.stderr.write(lines.map((l) => 'tracetoon: ' + l).join('\n') + '\n');
  // 3 is the launcher's "no runtime" exit code (docs/agents/errors.md).
  process.exit(3);
}

const key = process.platform + '-' + process.arch;
const name = '@tracetoon/cli-' + key;
let pkgDir;
try {
  pkgDir = path.dirname(require.resolve(name + '/package.json'));
} catch {
  fail([
    SUPPORTED.includes(key)
      ? 'the binary package ' + name + ' is not installed.'
      : 'there is no prebuilt binary for ' +
        key +
        ' (supported: ' +
        SUPPORTED.join(', ') +
        ').',
    'npm installs it as an optional dependency; installs with --omit=optional or',
    '--no-optional skip it. Reinstall without that flag: npm install tracetoon',
    'Other routes (installer, Claude Code plugin, skill from the release): ' + DOCS,
  ]);
}

const binary = path.join(
  pkgDir,
  'bin',
  process.platform === 'win32' ? 'tracetoon.exe' : 'tracetoon',
);
if (!existsSync(binary))
  fail([
    'the binary is missing from ' + pkgDir + '. Reinstall: npm install tracetoon',
    DOCS,
  ]);
if (process.platform !== 'win32') {
  try {
    // Some package managers drop the executable bit on files outside "bin".
    if ((statSync(binary).mode & 0o111) === 0) chmodSync(binary, 0o755);
  } catch {
    /* spawn reports it if the binary still can't run */
  }
}

const env = Object.assign({}, process.env);
const skill = path.join(__dirname, '..', 'skill', 'tracetoon');
if (existsSync(path.join(skill, 'SKILL.md'))) {
  // `tracetoon setup` installs this skill; comics need its fonts and renderer.
  if (!env.TRACETOON_SKILL_DIR) env.TRACETOON_SKILL_DIR = skill;
  if (!env.TRACETOON_ASSETS) env.TRACETOON_ASSETS = path.join(skill, 'assets');
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit', env });
const forward = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const relay = {};
for (const signal of forward) {
  relay[signal] = () => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  try {
    process.on(signal, relay[signal]);
  } catch {
    /* not supported on this platform */
  }
}
child.on('error', (e) => fail(['could not run ' + binary + ': ' + e.message, DOCS]));
child.on('exit', (code, signal) => {
  for (const s of forward) process.removeListener(s, relay[s]);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 1 : code);
});
