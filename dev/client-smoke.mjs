/**
 * Offline smoke test for the browser half of this bundle.
 *
 * Runs `client.js` in a sandbox with a stub `window.__ModuleLoader__`, then
 * applies the module to a stub client context. It asserts the two things the
 * Host depends on: the module id equals the package name, and the module puts
 * exactly one entry into the composer tool row.
 *
 *   node dev/client-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let descriptor;
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(value) {
        descriptor = value;
      },
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });

assert.ok(descriptor !== undefined, 'client.js calls window.__ModuleLoader__.load');
assert.equal(descriptor.id, packageJson.name, 'module id must equal the package name');
assert.equal(typeof descriptor.factory, 'function', 'factory');

/* ---- The factory ---------------------------------------------------------- */

const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const React = {
  createElement: element,
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (value) => value,
};

const clientModule = descriptor.factory((specifier) => {
  assert.equal(specifier, 'react', `unexpected require(${specifier})`);
  return React;
});

// `[...]` because the value is built inside the vm realm, whose Array prototype
// is not the one `assert` compares against.
assert.deepEqual([...clientModule.inject], ['slots'], 'module injects slots');
assert.equal(typeof clientModule.apply, 'function', 'module apply');

/* ---- Slot registration ---------------------------------------------------- */

const injected = [];
const registered = [];
const ctx = {
  slots: {
    inject(name, factory) {
      injected.push(name);
      factory();
    },
    register(entry, component) {
      registered.push({ entry, component });
      return () => {};
    },
  },
};

clientModule.apply(ctx);

assert.deepEqual(injected, ['conversation.input.left'], 'composer tool row slot');
assert.equal(registered.length, 1, 'exactly one slot entry');
const [{ entry, component }] = registered;
assert.equal(entry.name, 'conversation.input.left', 'entry slot name');
assert.equal(entry.id, 'literature-toggle', 'entry id');
assert.equal(typeof entry.order, 'number', 'entry order');
assert.equal(typeof component, 'function', 'entry component');

/* ---- Component shape (render-free) ---------------------------------------- */

const rendered = component({ sessionId: 'abc123' });
assert.equal(rendered.type, 'Fragment', 'component renders a fragment');
const [style, button] = rendered.props.children;
assert.equal(style.type, 'style', 'styles are inlined');
assert.match(String(style.props.children), /--dsw-alias-brand-primary/, 'uses Host theme tokens');
assert.equal(button.type, 'button', 'renders a button');
assert.equal(button.props.role, 'switch', 'exposed as a switch');
assert.equal(button.props['data-on'], '0', 'unknown state starts off');
assert.ok(Array.isArray(button.props.children), 'button has children');

console.log('ok — module id matches the package, one composer entry registered');
