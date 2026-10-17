// Validate the package with published dependencies and pinned integration fixtures.
// Every checkout and install happens outside the caller's workspace.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'glial-release-'));
const candidate = join(temporary, 'glial');
const fixtures = JSON.parse(readFileSync(join(root, 'scripts/release-fixtures.json'), 'utf8'));
function run(command, args, cwd = candidate) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { throw new Error(`${command} failed (${result.status})`); }
}
try {
  cpSync(root, candidate, {
    recursive: true,
    filter: (path) => !['.git', 'node_modules', 'dist'].includes(basename(path)) && !path.endsWith('.tgz'),
  });
  for (const [name, revision] of Object.entries(fixtures)) {
    const checkout = join(temporary, name);
    mkdirSync(checkout);
    run('git', ['init', '--quiet'], checkout);
    run('git', ['fetch', '--quiet', '--depth=1', `https://github.com/owebeeone/${name}.git`, revision], checkout);
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], checkout);
  }
  run('pnpm', ['install', '--frozen-lockfile']);
  run('pnpm', ['typecheck']);
  run('pnpm', ['test']);
  const artifacts = join(temporary, 'artifacts');
  mkdirSync(artifacts);
  run('pnpm', ['pack', '--pack-destination', artifacts]);
  const tarballs = readdirSync(artifacts).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1);
  const consumer = join(temporary, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'glial-release-consumer', private: true, type: 'module' }));
  run('pnpm', ['add', join(artifacts, tarballs[0]), '@owebeeone/grip-core@0.3.0', 'typescript@5.8.3'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@owebeeone/glial/package.json'), 'utf8'));
  assert.equal(installed.name, '@owebeeone/glial');
  assert.equal(installed.main, './dist/index.js');
  for (const dependency of Object.values(installed.dependencies)) {
    assert.ok(!/^(file:|link:|workspace:)/.test(dependency), 'local dependency in published package');
  }
  const checks = [
    ['@owebeeone/glial', 'GlialBinder'],
    ['@owebeeone/glial/grip', 'GlialTap'],
    ['@owebeeone/glial/supplier', 'Supplier'],
    ['@owebeeone/glial/manifest', 'defineManifest'],
  ];
  const imports = checks.map(([specifier, symbol]) => `import { ${symbol} } from '${specifier}';`).join('\n');
  const assertions = checks.map(([, symbol]) => `assert.equal(typeof ${symbol}, 'function');`).join('\n');
  writeFileSync(join(consumer, 'check.mjs'), `import assert from 'node:assert/strict';\n${imports}\n${assertions}\n`);
  writeFileSync(join(consumer, 'check.ts'), `${imports}\nexport const api = { ${checks.map(([, symbol]) => symbol).join(', ')} };\n`);
  run('node', ['check.mjs'], consumer);
  run('pnpm', ['exec', 'tsc', '--noEmit', '--strict', '--module', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', 'false', 'check.ts'], consumer);
  console.log('Glial release checks passed: typecheck, tests, package, and all four consumer entry points.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
