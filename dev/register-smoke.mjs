/**
 * Offline smoke test for the Host half of this bundle.
 *
 * Loads `index.js` against a minimal Cordis-shaped stub and asserts what the
 * plugin actually installs: the nine tool definitions (with JSON Schema that a
 * model adapter accepts), the two HTTP routes behind the composer switch, and
 * the `literatureSkills` service the second bundle row injects.
 *
 *   node dev/register-smoke.mjs
 *
 * It touches no network and writes no state outside a temp `DSH_HOME`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-lit-smoke-'));

const tools = new Map();
const routes = [];
const provided = new Map();
const events = [];
const disposers = [];

const server = {
  register(spec) {
    routes.push(spec);
    return () => {};
  },
};

const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
      return () => {};
    },
  },
  effect(factory) {
    disposers.push(factory());
  },
  on(name, handler) {
    events.push({ name, handler });
    return () => {};
  },
  provide(name, value) {
    provided.set(name, value);
    return () => {};
  },
  get(name) {
    return name === 'webServer' ? server : undefined;
  },
  inject() {
    /* `get('webServer')` already resolved, so this path stays unused. */
  },
  agents: {
    list() {
      return [];
    },
    get() {
      return undefined;
    },
  },
};

const plugin = await import('../index.js');
assert.equal(plugin.name, 'literature-agents', 'plugin name');
assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'subagents', 'agents']);

plugin.apply(ctx, {});

/* ---- Tools ---------------------------------------------------------------- */

const expected = [
  'list_literature_experts',
  'summon_literature_expert',
  'run_literature_panel',
  'search_scholar_papers',
  'get_scholar_biography',
  'search_classic_texts',
  'get_classic_text',
  'translate_classic',
  'verify_citation',
];
assert.deepEqual([...tools.keys()].sort(), [...expected].sort(), 'registered tool names');

const types = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

for (const [name, definition] of tools) {
  assert.equal(typeof definition.description, 'string', `${name}: description`);
  assert.ok(definition.description.length > 20, `${name}: description is substantive`);
  const schema = definition.parameters;
  assert.ok(schema !== null && typeof schema === 'object', `${name}: parameters object`);
  assert.equal(schema.type, 'object', `${name}: parameters.type`);
  assert.equal(typeof schema.properties, 'object', `${name}: parameters.properties`);
  for (const [key, property] of Object.entries(schema.properties)) {
    assert.ok(property !== null && typeof property === 'object', `${name}.${key}: property`);
    assert.ok(
      !Object.hasOwn(property, 'required'),
      `${name}.${key}: a per-property "required" boolean is not JSON Schema and the model adapter rejects it`,
    );
    if (Object.hasOwn(property, 'type')) {
      assert.ok(types.has(property.type), `${name}.${key}: unknown type ${String(property.type)}`);
    }
    assert.equal(typeof property.description, 'string', `${name}.${key}: description`);
  }
  if (Object.hasOwn(schema, 'required')) {
    assert.ok(Array.isArray(schema.required), `${name}: required must be an array`);
    for (const key of schema.required) {
      assert.ok(Object.hasOwn(schema.properties, key), `${name}: required ${key} is not a property`);
    }
  }
  assert.equal(typeof definition.execute, 'function', `${name}: execute`);
}

/* ---- Composer switch ------------------------------------------------------ */

const paths = routes.map((route) => route.path).sort();
assert.deepEqual(
  paths,
  ['/plugins/dsh-literature-agents/state', '/plugins/dsh-literature-agents/toggle'],
  'switch routes',
);
for (const route of routes) {
  assert.equal(route.kind, 'exact', `${route.path}: kind`);
  assert.equal(typeof route.handler, 'function', `${route.path}: handler`);
}

/* ---- Services and lifecycle ----------------------------------------------- */

assert.ok(provided.has('literatureSkills'), 'publishes literatureSkills');
assert.match(provided.get('literatureSkills').skillsDir, /skills[\\/]literature-research$/, 'skills dir');
assert.ok(events.some((event) => event.name === 'agent/created'), 'listens for agent/created');
assert.ok(disposers.every((dispose) => typeof dispose === 'function'), 'effect disposers');

console.log(`ok — ${tools.size} tools, ${routes.length} routes, literatureSkills published`);
