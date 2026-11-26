// dsh-literature-agents — browser-half smoke test.
//
// `client.js` is a __ModuleLoader__ bundle, so it can only be checked by giving it
// the three globals a Web client provides: `window.__ModuleLoader__`, `React` and
// `fetch`. This harness supplies a miniature React (useState/useEffect with a
// real re-render loop), records every request the button makes, and asserts the
// rendered switch — including what it sends when the Host answers or fails.
//
//   node dev/client-smoke.mjs

import assert from 'node:assert/strict';

const SLOT = 'conversation.input.left';
const ENTRY_ID = 'literature-toggle';
const ROUTE = '/plugins/dsh-literature-agents';

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

/* ---- the three globals a Web client provides ---------------------------- */

let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded = module;
    },
  },
};

const requests = [];
let responder = () => ({ ok: true, json: () => ({ sessionId: 'session-1', enabled: true }) });
globalThis.fetch = (url, options) => {
  requests.push({ url, options: options ?? {} });
  return Promise.resolve(responder(url, options));
};

const json = (body) => () => ({ ok: true, json: () => body });
// A real fetch fails asynchronously; a synchronous throw would not reach the
// component's .catch().
const offline = () => Promise.reject(new Error('network down'));

/* ---- a miniature React with a real render loop -------------------------- */

function createHarness() {
  const harness = {
    states: [],
    deps: [],
    cursor: 0,
    queued: [],
    dirty: false,
    tree: null,
    renders: 0,
    Component: null,
    props: null,
  };

  harness.react = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    useState(initial) {
      const index = harness.cursor;
      harness.cursor += 1;
      if (index >= harness.states.length) {
        harness.states.push(typeof initial === 'function' ? initial() : initial);
      }
      return [
        harness.states[index],
        (value) => {
          harness.states[index] =
            typeof value === 'function' ? value(harness.states[index]) : value;
          harness.dirty = true;
        },
      ];
    },
    useEffect(effect, deps) {
      const index = harness.cursor;
      harness.cursor += 1;
      const previous = harness.deps[index];
      const changed =
        previous === undefined ||
        !Array.isArray(previous) ||
        !Array.isArray(deps) ||
        deps.some((value, position) => value !== previous[position]);
      harness.deps[index] = deps;
      if (changed) harness.queued.push(effect);
    },
  };

  harness.draw = () => {
    harness.cursor = 0;
    harness.renders += 1;
    harness.tree = harness.Component(harness.props);
    return harness.tree;
  };

  harness.mount = (Component, props) => {
    harness.Component = Component;
    harness.props = props;
    return harness.draw();
  };

  harness.settle = async () => {
    for (let round = 0; round < 20; round += 1) {
      for (const effect of harness.queued.splice(0)) effect();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!harness.dirty) return harness.tree;
      harness.dirty = false;
      harness.draw();
    }
    throw new Error('the render loop never settled');
  };

  return harness;
}

function nodes(tree, predicate, found = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, predicate, found);
    return found;
  }
  if (tree === null || typeof tree !== 'object') return found;
  if (predicate(tree)) found.push(tree);
  for (const child of tree.children ?? []) nodes(child, predicate, found);
  return found;
}

const one = (tree, predicate) => {
  const hits = nodes(tree, predicate);
  assert.equal(hits.length, 1, 'expected exactly one node, saw ' + hits.length);
  return hits[0];
};

const buttonOf = (tree) => one(tree, (node) => node.type === 'button');
const textsOf = (tree, found = []) => {
  if (Array.isArray(tree)) {
    for (const child of tree) textsOf(child, found);
    return found;
  }
  if (typeof tree === 'string' || typeof tree === 'number') {
    found.push(String(tree));
    return found;
  }
  if (tree === null || typeof tree !== 'object') return found;
  for (const child of tree.children ?? []) textsOf(child, found);
  return found;
};

console.log('dsh-literature-agents client smoke test');

/* ---- 1. Bundle contract ------------------------------------------------- */

await import('../client.js');

await check('the bundle registers under the package name', () => {
  assert.ok(loaded, 'window.__ModuleLoader__.load was never called');
  assert.equal(loaded.id, 'dsh-literature-agents');
  assert.equal(typeof loaded.factory, 'function');
});

const harness = createHarness();
const module = loaded.factory((id) => {
  assert.equal(id, 'react', 'the bundle must only require react');
  return harness.react;
});

await check('the factory contributes one slot and no more', () => {
  assert.deepEqual(module.inject, ['slots']);
  assert.equal(typeof module.apply, 'function');
});

let injectedSlot;
let registered;
let Component;
const slots = {
  inject(name, callback) {
    injectedSlot = name;
    callback();
  },
  register(entry, component) {
    registered = entry;
    Component = component;
    return () => {};
  },
};

await check('apply registers the composer entry', () => {
  module.apply({ slots });
  assert.equal(injectedSlot, SLOT);
  assert.deepEqual(registered, { name: SLOT, id: ENTRY_ID, order: 20 });
  assert.equal(typeof Component, 'function');
});

/* ---- 2. First paint and Host read -------------------------------------- */

responder = json({ sessionId: 'session-1', enabled: true });
harness.mount(Component, { sessionId: 'session-1' });
const first = harness.tree;

await check('the first paint is a muted reading state', () => {
  const button = buttonOf(first);
  assert.equal(button.props.role, 'switch');
  assert.equal(button.props['aria-checked'], false);
  assert.equal(button.props['data-on'], '0');
  assert.equal(button.props.disabled, false);
  assert.equal(button.props.title, '正在读取古籍插件状态…');
  assert.ok(textsOf(first).includes('古籍'));
});

await check('the button reads its state from the Host route', async () => {
  await harness.settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, ROUTE + '/state?session=session-1');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.method, undefined, 'reading state must not write');
  const button = buttonOf(harness.tree);
  assert.equal(button.props['aria-checked'], true);
  assert.equal(button.props['data-on'], '1');
  assert.equal(button.props.title, '古籍插件已开启（本对话）：点击关闭，下一轮生效');
});

/* ---- 3. Flipping from the UI ------------------------------------------- */

await check('a click posts the toggle and follows the answer', async () => {
  responder = json({ sessionId: 'session-1', enabled: false });
  buttonOf(harness.tree).props.onClick();
  await harness.settle();
  const post = requests.filter((entry) => entry.options.method === 'POST').pop();
  assert.ok(post, 'no POST was sent');
  assert.equal(post.url, ROUTE + '/toggle');
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(post.options.body), { sessionId: 'session-1' });
  const button = buttonOf(harness.tree);
  assert.equal(button.props['data-on'], '0');
  assert.equal(button.props['aria-checked'], false);
  assert.equal(button.props.title, '古籍插件已关闭（本对话）：点击开启');
  assert.equal(button.props.disabled, false, 'the button must leave its busy state');
});

/* ---- 4. Host failures --------------------------------------------------- */

await check('a failed read shows the retry hint and retries with GET', async () => {
  const failing = createHarness();
  const module2 = loaded.factory(() => failing.react);
  let retryComponent;
  module2.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (entry, component) => {
        retryComponent = component;
      },
    },
  });
  responder = offline;
  const before = requests.length;
  failing.mount(retryComponent, { sessionId: 'session-2' });
  await failing.settle();
  const button = buttonOf(failing.tree);
  assert.equal(button.props['data-failed'], '1');
  assert.equal(button.props.title, '古籍插件状态读取失败：点击重试');
  assert.equal(requests.length, before + 1);
  button.props.onClick();
  await failing.settle();
  assert.equal(requests.length, before + 2);
  assert.equal(requests[before + 1].url, ROUTE + '/state?session=session-2');
  assert.equal(requests[before + 1].options.method, undefined, 'a retry must not toggle');
});

await check('no session id keeps the button inert and silent', async () => {
  const idle = createHarness();
  const module3 = loaded.factory(() => idle.react);
  let idleComponent;
  module3.apply({
    slots: {
      inject: (name, callback) => callback(),
      register: (entry, component) => {
        idleComponent = component;
      },
    },
  });
  const before = requests.length;
  idle.mount(idleComponent, {});
  await idle.settle();
  const button = buttonOf(idle.tree);
  assert.equal(requests.length, before);
  button.props.onClick();
  await idle.settle();
  assert.equal(requests.length, before);
});

/* ---- 5. Presentation ---------------------------------------------------- */

await check('styles, glyph and label are inline, theme-token based', () => {
  const style = one(harness.tree, (node) => node.type === 'style');
  const css = textsOf(style).join('');
  assert.ok(css.includes('.dslt-btn'), 'no button class');
  assert.ok(css.includes('var(--dsw-alias-brand-primary)'), 'no brand token');
  assert.ok(css.includes('var(--dsw-alias-border-l1)'), 'no border token');
  const svg = one(harness.tree, (node) => node.type === 'svg');
  assert.equal(svg.props['aria-hidden'], 'true');
  assert.equal(nodes(svg, (node) => node.type === 'path').length, 3);
  assert.ok(textsOf(harness.tree).includes('古籍'));
});

console.log('');
if (failures === 0) {
  console.log('client smoke: all checks passed');
  process.exit(0);
}
console.log('client smoke: ' + failures + ' check(s) failed');
process.exit(1);
