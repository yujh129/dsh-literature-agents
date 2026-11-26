// dsh-literature-agents — Host-half smoke test.
//
// Boots `index.js` against a fake cordis context and checks every surface a host
// consumes: the nine tools, the two toggle routes, the per-session gate, and one
// expert run under both provider-registry shapes a DSH host can have
// (0.2.1 answers subagents.list(); 0.2.2 only answers getProvider(name)).
// No network and no real host: every service here is a fake.
//
//   node dev/register-smoke.mjs

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dslt-smoke-'));
process.env.DSH_HOME = home;

const plugin = await import('../index.js');

const TOOL_NAMES = [
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
const STATE_PATH = '/plugins/dsh-literature-agents/state';
const TOGGLE_PATH = '/plugins/dsh-literature-agents/toggle';
const GUIDE_SECTION = 'literature-agents:experts';

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

/**
 * A cordis-shaped context carrying only the members this plugin touches.
 * registry: 'list' reproduces DSH <= 0.2.1, 'by-name' reproduces DSH >= 0.2.2.
 * webServer: 'direct' | 'inject' | 'none' selects how the Web server is found.
 */
function makeCtx(options = {}) {
  const providers = options.providers ?? ['spawn'];
  const registry = options.registry ?? 'by-name';
  const webServerMode = options.webServer ?? 'direct';
  const agents = new Map();
  const tools = new Map();
  const routes = [];
  const effects = [];
  const listeners = new Map();
  const denied = new Map();

  const activity = {
    provider: null,
    label: null,
    childId: null,
    maxDepth: undefined,
    disposed: 0,
  };

  const subagents = {
    getProvider: (token) =>
      providers.includes(token) ? { name: token, capabilities: { depthLimit: true } } : undefined,
    startActivation: async (request) => {
      if (!providers.includes(request.provider)) {
        const error = new Error('no subagent provider registered for "' + request.provider + '"');
        error.code = 'NO_PROVIDER';
        throw error;
      }
      activity.provider = request.provider;
      activity.label = request.label;
      activity.childId = request.childId;
      activity.maxDepth = request.request.maxDepth;
      return {
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: '专家答复：' + request.label }],
        }),
        dispose: async () => {
          activity.disposed += 1;
        },
      };
    },
  };
  if (registry === 'list') subagents.list = () => [...providers];

  const server = {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  };

  function makeAgent(id) {
    const agent = {
      id,
      sections: [],
      ctx: {
        tools: {
          restrict: ({ deny }) => {
            denied.set(id, new Set(deny));
            return () => denied.delete(id);
          },
        },
        systemPrompt: {
          section: (section) => {
            agent.sections.push(section);
            return () => {};
          },
        },
        effect: (execute) => execute(),
      },
    };
    agents.set(id, agent);
    return agent;
  }

  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      restrict: () => {},
      schemas: (agent) =>
        [...tools.keys()]
          .filter((name) => !(denied.get(agent && agent.id)?.has(name) ?? false))
          .map((name) => ({ name })),
    },
    systemPrompt: { section: () => () => {} },
    subagents,
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    effect: (execute, label) => {
      const dispose = execute();
      effects.push({ label, dispose });
      return dispose;
    },
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return () => listeners.set(event, bucket.filter((entry) => entry !== listener));
    },
    provide: () => {},
    get: (service) =>
      service === 'webServer' && webServerMode === 'direct' ? server : undefined,
    inject: (names, callback) => {
      if (webServerMode === 'inject' && names.includes('webServer')) {
        callback({ get: () => server, webServer: server });
      }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  return { ctx, tools, routes, effects, listeners, activity, agents, denied, makeAgent, home };
}

function route(ctx, path) {
  const found = ctx.routes.find((entry) => entry.path === path);
  assert.ok(found, 'route not registered: ' + path);
  assert.equal(found.kind, 'exact');
  return found;
}

function fakeRes() {
  const res = {
    status: 0,
    body: undefined,
    writeHead(status) {
      res.status = status;
    },
    end(payload) {
      res.body = payload === undefined ? undefined : JSON.parse(payload);
    },
  };
  return res;
}

const getReq = (url) => ({ method: 'GET', url });

function postReq(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const handlers = {};
  const req = {
    method: 'POST',
    url: TOGGLE_PATH,
    destroy: () => {},
    on: (event, listener) => {
      handlers[event] = listener;
      return req;
    },
  };
  queueMicrotask(() => {
    if (handlers.data) handlers.data(raw);
    if (handlers.end) handlers.end();
  });
  return req;
}

console.log('dsh-literature-agents host smoke test');
console.log('DSH_HOME=' + home);

/* ---- 1. Manifest surface ------------------------------------------------- */

await check('exports name/inject/apply', () => {
  assert.equal(plugin.name, 'literature-agents');
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'subagents', 'agents']);
  assert.equal(typeof plugin.apply, 'function');
});

/* ---- 2. Tools ----------------------------------------------------------- */

const boot = makeCtx();
await plugin.apply(boot.ctx, {});

await check('registers exactly the nine literature tools', () => {
  assert.deepEqual([...boot.tools.keys()].sort(), [...TOOL_NAMES].sort());
});

await check('every tool declares a description, parameters and a string output', () => {
  for (const definition of boot.tools.values()) {
    assert.equal(typeof definition.name, 'string');
    assert.ok(definition.description.length >= 40, definition.name + ': description too short');
    assert.equal(definition.parameters?.type, 'object', definition.name + ': parameters');
    assert.equal(definition.output?.schema?.type, 'string', definition.name + ': output.schema');
    assert.equal(typeof definition.output.render, 'function', definition.name + ': output.render');
    assert.equal(typeof definition.execute, 'function', definition.name + ': execute');
  }
});

await check('every tool declares itself safe to run in parallel', () => {
  for (const name of TOOL_NAMES) {
    const definition = boot.tools.get(name);
    assert.equal(typeof definition.isConcurrencySafe, 'function', name + ': no isConcurrencySafe');
    assert.equal(definition.isConcurrencySafe(), true, name);
  }
});

/* ---- 3. Toggle routes --------------------------------------------------- */

await check('registers both toggle routes and one disposer per effect', () => {
  route(boot, STATE_PATH);
  route(boot, TOGGLE_PATH);
  const labels = boot.effects.map((entry) => entry.label);
  assert.ok(labels.includes('literature-agents: state route'));
  assert.ok(labels.includes('literature-agents: toggle route'));
  assert.ok(labels.includes('literature-agents: session gates'));
});

await check('GET state reports a fresh session as enabled (opt-out, not opt-in)', async () => {
  const res = fakeRes();
  await route(boot, STATE_PATH).handler(getReq(STATE_PATH + '?session=smoke-a'), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sessionId: 'smoke-a', enabled: true });
});

await check('POST toggle flips to off and persists the choice', async () => {
  const res = fakeRes();
  await route(boot, TOGGLE_PATH).handler(postReq({ sessionId: 'smoke-a' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sessionId: 'smoke-a', enabled: false });
  const again = fakeRes();
  await route(boot, STATE_PATH).handler(getReq(STATE_PATH + '?session=smoke-a'), again);
  assert.equal(again.body.enabled, false);
  const file = JSON.parse(readFileSync(join(home, 'dsh-literature-agents', 'toggles.json'), 'utf8'));
  assert.equal(file['smoke-a'], false);
});

await check('toggling again turns the session back on', async () => {
  const res = fakeRes();
  await route(boot, TOGGLE_PATH).handler(postReq({ sessionId: 'smoke-a' }), res);
  assert.equal(res.body.enabled, true);
});

await check('explicit enabled and invalid session ids are handled', async () => {
  const off = fakeRes();
  await route(boot, TOGGLE_PATH).handler(postReq({ sessionId: 'smoke-a', enabled: false }), off);
  assert.equal(off.body.enabled, false);
  const bad = fakeRes();
  await route(boot, TOGGLE_PATH).handler(postReq({ sessionId: 'no/slash' }), bad);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'invalid session id' });
});

await check('wrong methods answer 405', async () => {
  const res = fakeRes();
  await route(boot, STATE_PATH).handler({ method: 'POST', url: STATE_PATH }, res);
  assert.equal(res.status, 405);
  const res2 = fakeRes();
  await route(boot, TOGGLE_PATH).handler({ method: 'GET', url: TOGGLE_PATH }, res2);
  assert.equal(res2.status, 405);
});

/* ---- 4. Per-session gate ------------------------------------------------ */

await check('enabling a session installs the guide on its agent', async () => {
  const on = fakeRes();
  await route(boot, TOGGLE_PATH).handler(postReq({ sessionId: 'smoke-on', enabled: true }), on);
  assert.equal(on.body.enabled, true);
  const listener = boot.listeners.get('agent/created')[0];
  const agent = boot.makeAgent('smoke-on');
  listener({ agent });
  const section = agent.sections.find((entry) => entry.name === GUIDE_SECTION);
  assert.ok(section, 'guide section missing');
  assert.equal(section.order, 700);
  assert.ok(section.text.length > 400, 'guide text looks empty');
  assert.ok(boot.denied.get('smoke-on') === undefined, 'enabled agent must not be restricted');
});

await check('a disabled session is denied the nine tools', async () => {
  const off = fakeRes();
  await route(boot, TOGGLE_PATH).handler(postReq({ sessionId: 'smoke-off', enabled: false }), off);
  assert.equal(off.body.enabled, false);
  const listener = boot.listeners.get('agent/created')[0];
  const agent = boot.makeAgent('smoke-off');
  listener({ agent });
  assert.equal(agent.sections.length, 0);
  const denied = boot.denied.get('smoke-off');
  assert.ok(denied, 'no restriction installed');
  for (const name of TOOL_NAMES) assert.ok(denied.has(name), 'not denied: ' + name);
});

await check('a saved choice survives a restart and gates agents alive at apply()', async () => {
  // A saved choice is read during apply(), so a restart keeps opted-out sessions off.
  mkdirSync(join(home, 'dsh-literature-agents'), { recursive: true });
  writeFileSync(
    join(home, 'dsh-literature-agents', 'toggles.json'),
    JSON.stringify({ 'preexisting-off': false, 'preexisting-on': true }),
    'utf8',
  );
  // A cache-busted specifier gives a second module instance with empty in-memory state.
  const restarted = await import('../index.js?restart=1');
  const ctx = makeCtx();
  ctx.makeAgent('preexisting-off');
  ctx.makeAgent('preexisting-on');
  await restarted.apply(ctx.ctx, {});
  assert.ok(ctx.denied.get('preexisting-off')?.has('verify_citation'), 'opted-out agent not restricted');
  assert.ok(
    ctx.agents.get('preexisting-on').sections.some((entry) => entry.name === GUIDE_SECTION),
    'enabled agent got no guide',
  );
});

await check('probe reports the live agent and visible schemas', async () => {
  const res = fakeRes();
  await route(boot, TOGGLE_PATH).handler(postReq({ sessionId: 'smoke-on', enabled: true, probe: true }), res);
  assert.equal(res.status, 200);
  assert.equal(res.body.agentFound, true);
  assert.equal(res.body.agentService, true);
  assert.ok(res.body.agentCount >= 1);
  assert.equal(res.body.literatureVisible, true);
});

/* ---- 5. Web server discovery ------------------------------------------- */

await check('the button routes install when the Web server arrives via inject()', async () => {
  const ctx = makeCtx({ webServer: 'inject' });
  await plugin.apply(ctx.ctx, {});
  route(ctx, STATE_PATH);
  route(ctx, TOGGLE_PATH);
});

await check('a host without a Web server still gets the tools', async () => {
  const ctx = makeCtx({ webServer: 'none' });
  await plugin.apply(ctx.ctx, {});
  assert.equal(ctx.routes.length, 0);
  assert.equal(ctx.tools.size, TOOL_NAMES.length);
});

/* ---- 6. Provider resolution across host generations -------------------- */

const exec = () => ({ agent: { id: 'parent-1' }, signal: new AbortController().signal });

await check('summon_literature_expert runs on a 0.2.2 host (no list())', async () => {
  const ctx = makeCtx({ registry: 'by-name', providers: ['spawn'] });
  await plugin.apply(ctx.ctx, {});
  const text = await ctx.tools
    .get('summon_literature_expert')
    .execute({ expert: 'textual-critic', task: '校勘这一段。' }, exec());
  assert.ok(text.includes('【专家】'), text);
  assert.ok(text.includes('专家答复：'), text);
  assert.equal(ctx.activity.provider, 'spawn');
  assert.equal(ctx.activity.maxDepth, 1);
  assert.equal(ctx.activity.disposed, 1);
});

await check('summon_literature_expert runs on a 0.2.1 host (list() present)', async () => {
  const ctx = makeCtx({ registry: 'list', providers: ['spawn'] });
  await plugin.apply(ctx.ctx, {});
  const text = await ctx.tools
    .get('summon_literature_expert')
    .execute({ expert: '校勘学家', task: '校勘这一段。' }, exec());
  assert.ok(text.includes('专家答复：'), text);
});

await check('an unknown configured provider is refused with the available names', async () => {
  const ctx = makeCtx({ registry: 'list', providers: ['spawn'] });
  await plugin.apply(ctx.ctx, { provider: 'nope' });
  await assert.rejects(
    () => ctx.tools.get('summon_literature_expert').execute({ expert: 'textual-critic', task: 'x' }, exec()),
    (error) => error.message.includes('未注册') && error.message.includes('spawn'),
  );
});

await check('with no provider at all the host names the missing provider', async () => {
  const ctx = makeCtx({ registry: 'by-name', providers: [] });
  await plugin.apply(ctx.ctx, { provider: 'spawn' });
  await assert.rejects(
    () => ctx.tools.get('summon_literature_expert').execute({ expert: 'textual-critic', task: 'x' }, exec()),
    (error) => error.code === 'NO_PROVIDER',
  );
});

await check('run_literature_panel aggregates every member', async () => {
  const ctx = makeCtx();
  await plugin.apply(ctx.ctx, {});
  const text = await ctx.tools
    .get('run_literature_panel')
    .execute({ panel: 'literature-review-panel', task: '评审这篇论文。' }, exec());
  assert.ok(text.includes('【评审团】'), text);
  assert.ok(/\d+\/\d+ 位成员返回结果/.test(text), text);
});

await check('list_literature_experts lists the roster and rejects unknown domains', async () => {
  const ctx = makeCtx();
  await plugin.apply(ctx.ctx, {});
  const text = await ctx.tools.get('list_literature_experts').execute({}, exec());
  assert.ok(text.includes('textual-critic'), text.slice(0, 200));
  await assert.rejects(
    () => ctx.tools.get('list_literature_experts').execute({ domain: 'nope' }, exec()),
    (error) => error.message.includes('未知领域'),
  );
});

await check('search tools refuse an empty query instead of guessing', async () => {
  const ctx = makeCtx();
  await plugin.apply(ctx.ctx, {});
  await assert.rejects(() => ctx.tools.get('search_scholar_papers').execute({}, exec()));
});

rmSync(home, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  console.log('host smoke: all checks passed');
  process.exit(0);
}
console.log('host smoke: ' + failures + ' check(s) failed');
process.exit(1);
