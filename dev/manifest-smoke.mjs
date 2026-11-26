// dsh-literature-agents — package/manifest preflight.
//
// Checks the parts a Host or the market registry reads before any code runs:
// package.json (dsh.bundle / dsh.client / engines / exports / files),
// cordis.patch.yml, the locale pair, the bundled skill, and the cross-file
// agreements between index.js, client.js and the package name. It has no
// dependencies, so it also runs from a checkout with nothing installed.
//
//   node dev/manifest-smoke.mjs

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

let failures = 0;
async function check(label, body) {
  try {
    await body();
    console.log('ok   ' + label);
  } catch (error) {
    failures += 1;
    const message = String((error && error.message) || error).split('\n').join('\n     ');
    console.log('FAIL ' + label + '\n     ' + message);
  }
}

/* ---- a dependency-free semver subset (comparators + || + prerelease) ----- */

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(text).trim(),
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length) return 0;
    // A release outranks any prerelease of the same version.
    return a.pre.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.pre[index];
    const right = b.pre[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim());
  const operator = match[1] ?? '=';
  const target = parseVersion(match[2]);
  if (target === undefined) throw new Error('unparsable comparator: ' + comparator);
  const order = compareVersions(version, target);
  if (operator === '>=') return order >= 0;
  if (operator === '>') return order > 0;
  if (operator === '<=') return order <= 0;
  if (operator === '<') return order < 0;
  return order === 0;
}

function satisfies(versionText, range) {
  const version = parseVersion(versionText);
  if (version === undefined) return false;
  return range
    .split('||')
    .some((alternative) =>
      alternative
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((comparator) => satisfiesComparator(version, comparator)),
    );
}

console.log('dsh-literature-agents manifest preflight');
console.log('package root: ' + root);

const pkg = readJson('package.json');
const patch = read('cordis.patch.yml');

/** True when a `files` pattern covers this package-relative path. */
function inFiles(relative) {
  return (pkg.files ?? []).some((pattern) => {
    if (pattern === relative) return true;
    if (pattern.endsWith('/**')) return relative.startsWith(pattern.slice(0, -2));
    if (pattern.endsWith('/*.json')) {
      const prefix = pattern.slice(0, -6);
      return (
        relative.startsWith(prefix) &&
        relative.endsWith('.json') &&
        !relative.slice(prefix.length, -5).includes('/')
      );
    }
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      return relative.startsWith(prefix) && !relative.slice(prefix.length).includes('/');
    }
    return false;
  });
}

/* ---- 1. Identity -------------------------------------------------------- */

await check('the package is a valid ESM package named dsh-literature-agents', () => {
  assert.equal(pkg.name, 'dsh-literature-agents');
  assert.equal(pkg.type, 'module');
  assert.ok(parseVersion(pkg.version), 'version is not semver: ' + pkg.version);
  assert.equal(pkg.license, 'MIT');
});

await check('repository metadata names the GitHub project the market lists', () => {
  assert.equal(pkg.repository?.url, 'git+https://github.com/yujh129/dsh-literature-agents.git');
  const owner = /github\.com\/([^/]+)\/([^/.]+)/.exec(pkg.repository.url);
  assert.deepEqual(owner.slice(1), ['yujh129', 'dsh-literature-agents']);
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'));
});

/* ---- 2. Host manifest --------------------------------------------------- */

await check('dsh.bundle points at an existing patch file', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(existsSync(join(root, 'cordis.patch.yml')));
});

await check('dsh.client declares the web platform and its injections', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0);
  assert.ok(pkg.dsh.client.inject.every((name) => typeof name === 'string' && name !== ''));
  assert.ok(existsSync(join(root, 'client.js')));
});

await check('engines.dsh is a top-level, satisfiable range', () => {
  assert.equal(typeof pkg.engines?.dsh, 'string', 'engines.dsh must be a top-level string');
  assert.equal(pkg.dsh?.engines, undefined, 'engines must not be nested under dsh');
  assert.notEqual(pkg.engines.dsh.trim(), '');
  // The runtime versions this plugin was verified against, plus the ones it must refuse.
  for (const version of ['0.2.1-rc.2', '0.2.1', '0.2.2-rc.5', '0.3.0-rc.0', '0.3.1']) {
    assert.ok(satisfies(version, pkg.engines.dsh), version + ' should satisfy ' + pkg.engines.dsh);
  }
  for (const version of ['0.1.9', '0.2.0', '0.2.1-rc.1', '0.4.0-0', '0.4.1', '1.0.0']) {
    assert.ok(!satisfies(version, pkg.engines.dsh), version + ' should not satisfy ' + pkg.engines.dsh);
  }
});

await check('exports resolve to files the package actually ships', () => {
  const exports = pkg.exports ?? {};
  assert.equal(exports['.'], './index.js');
  assert.equal(exports['./client'], './client.js');
  assert.equal(exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(exports['./package.json'], './package.json');
  const concrete = Object.values(exports).filter(
    (value) => typeof value === 'string' && !value.includes('*'),
  );
  for (const value of concrete) {
    const relative = value.replace(/^\.\//, '');
    assert.ok(existsSync(join(root, relative)), 'missing export target: ' + relative);
    // npm always publishes package.json, README and LICENSE regardless of `files`.
    if (relative === 'package.json' || relative === 'README.md' || relative === 'LICENSE') continue;
    assert.ok(inFiles(relative), 'export target is not published: ' + relative);
  }
});

await check('files publishes the plugin and keeps dev/ out of the tarball', () => {
  for (const required of [
    'index.js',
    'client.js',
    'experts.js',
    'sources.js',
    'cordis.patch.yml',
    'locale/en.json',
    'locale/zh.json',
    'icon.svg',
    'README.md',
    'LICENSE',
    'skills/literature-research/SKILL.md',
  ]) {
    assert.ok(existsSync(join(root, required)), 'missing file: ' + required);
    assert.ok(inFiles(required), 'not published: ' + required);
  }
  for (const pattern of pkg.files) {
    assert.ok(!pattern.startsWith('dev'), 'dev/ must not be published: ' + pattern);
  }
  assert.ok(!inFiles('dev/register-smoke.mjs'));
});

/* ---- 3. Layer patch ----------------------------------------------------- */

await check('cordis.patch.yml inserts both rows with the expected wiring', () => {
  assert.ok(patch.includes('- insert:'), 'no insert row');
  assert.ok(/name: dsh-literature-agents\n/.test(patch), 'plugin row missing');
  assert.ok(patch.includes("name: '@deepseek-ai/dsh-skill-filesystem'"), 'skill row missing');
  assert.ok(/inject:\s*\n\s*- literatureSkills/.test(patch), 'skill row does not inject the service');
  assert.ok(patch.includes('ctx.literatureSkills.skillsDir'), 'skill row does not use the service');
  assert.ok(!patch.includes('\t'), 'YAML must not contain tabs');
  assert.ok(patch.endsWith('\n'), 'patch file should end with a newline');
  assert.ok(patch.includes('provider: spawn'), 'default provider missing from the row config');
});

await check('the plugin row loads this package under a stable id', () => {
  assert.ok(patch.includes('id: literature-agents'), 'row id changed');
  assert.ok(patch.includes('name: ' + pkg.name), 'row does not load this package');
});

/* ---- 4. Localization ---------------------------------------------------- */

const localeFiles = ['locale/en.json', 'locale/zh.json'];
const locales = Object.fromEntries(localeFiles.map((file) => [file, readJson(file)]));

await check('both locales describe the plugin and stay key-identical', () => {
  const keys = localeFiles.map((file) => Object.keys(locales[file]).sort().join(','));
  assert.equal(new Set(keys).size, 1, 'locales disagree on top-level keys: ' + keys.join(' | '));
  const metaKeys = localeFiles.map((file) => Object.keys(locales[file].meta ?? {}).sort().join(','));
  assert.equal(new Set(metaKeys).size, 1, 'locales disagree on meta keys: ' + metaKeys.join(' | '));
  for (const file of localeFiles) {
    assert.ok(locales[file].meta?.title?.length > 1, file + ': meta.title is empty');
    assert.ok(locales[file].meta?.description?.length > 1, file + ': meta.description is empty');
  }
});

await check('meta.detail, when present, points at a shipped Markdown file', () => {
  for (const file of localeFiles) {
    const detail = locales[file].meta?.detail;
    if (detail === undefined) continue;
    assert.equal(typeof detail, 'string', file + ': meta.detail must be a string');
    assert.ok(/\.(md|markdown)$/i.test(detail), file + ': meta.detail must end in .md or .markdown');
    assert.ok(
      !detail.includes('\\') && !detail.includes('./') && !detail.includes('..'),
      file + ': unsafe detail path',
    );
    assert.ok(existsSync(join(root, detail)), file + ': detail document is missing');
    assert.ok(inFiles(detail), file + ': detail document is not published');
  }
});

/* ---- 5. Bundled skill --------------------------------------------------- */

await check('the bundled skill has front matter with a name and a description', () => {
  const skill = read('skills/literature-research/SKILL.md');
  assert.ok(skill.startsWith('---\n'), 'SKILL.md must start with YAML front matter');
  const end = skill.indexOf('\n---', 3);
  assert.ok(end > 0, 'front matter is not closed');
  const front = skill.slice(3, end);
  assert.ok(/^name: literature-research$/m.test(front), 'front matter name changed');
  assert.ok(/^description:/m.test(front), 'front matter has no description');
  assert.ok(skill.length > 2000, 'skill looks too thin to be useful');
});

/* ---- 6. Cross-file agreement ------------------------------------------- */

await check('client.js registers under the package name', () => {
  const client = read('client.js');
  assert.ok(client.includes('window.__ModuleLoader__.load({'), 'no module loader call');
  assert.ok(client.includes("id: '" + pkg.name + "'"), 'bundle id does not match the package name');
  assert.ok(client.includes("require('react')"), 'the bundle must reuse the host React');
  assert.ok(!/^import /m.test(client), 'the client bundle must stay dependency-free');
});

await check('index.js and client.js agree on the route and the package name', () => {
  const index = read('index.js');
  const client = read('client.js');
  const route = /TOGGLE_ROUTE = '([^']+)'/.exec(index);
  assert.ok(route, 'TOGGLE_ROUTE not found in index.js');
  assert.equal(route[1], '/plugins/' + pkg.name);
  assert.ok(client.includes("const ROUTE = '" + route[1] + "'"), 'client uses another route');
  assert.ok(index.includes("export const name = 'literature-agents'"), 'host plugin name changed');
});

await check('the guide and persona sections keep their names and orders', () => {
  const index = read('index.js');
  assert.ok(index.includes("'literature-agents:experts'"), 'guide section name changed');
  assert.ok(index.includes("'literature-agents:expert-persona'"), 'persona section name changed');
  assert.ok(/GUIDE_ORDER = \d+/.test(index) && /PERSONA_ORDER = \d+/.test(index), 'section orders missing');
});

await check('README.md is a publishable document', () => {
  const readme = read('README.md');
  assert.ok(readme.length > 2000, 'README is too thin for a market detail page');
  assert.ok(!readme.startsWith('\uFEFF'), 'README must not start with a BOM');
  assert.ok(!readme.startsWith('---\n'), 'README must not start with front matter');
  assert.equal(statSync(join(root, 'README.md')).size, Buffer.byteLength(readme), 'README is not plain UTF-8');
});

console.log('');
if (failures === 0) {
  console.log('manifest preflight: all checks passed');
  process.exit(0);
}
console.log('manifest preflight: ' + failures + ' check(s) failed');
process.exit(1);
