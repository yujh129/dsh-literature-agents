/**
 * `dsh-literature-agents` — literature and classical-scholarship agents for
 * DeepSeek Harness 0.2.1-rc.2.
 *
 * Running logic mirrors `dsh-agency-agents-cs` / `@michengai/dsh-agency-agents`:
 * one Host row, model-facing tools, a standing system-prompt section, and
 * expert runs through `ctx.subagents.startActivation()` with the persona
 * injected into the child through `agent/created`.
 *
 * On top of the roster it adds the three capabilities the request centres on:
 * - scholarly paper search and historian biography lookup (Crossref, OpenAlex,
 *   Wikidata, with host web search as a labelled fallback);
 * - classical-text full-text search and reading (Chinese Wikisource), plus
 *   grounded translation through the translator expert;
 * - citation verification, so a citation is either confirmed against a real
 *   record or explicitly reported as unverified.
 *
 * In addition it publishes `literatureSkills`, which lets the bundle's second
 * Host row mount `skills/literature-research` through skill-filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SourceUnavailable,
  crossrefDoi,
  extractDoi,
  findOpenAlexAuthorWorks,
  mergePapers,
  searchCrossref,
  searchOpenAlex,
  summarizePerson,
  titleSimilarity,
  webSearch,
  wikidataEntity,
  wikidataSearch,
  wikisourcePage,
  wikisourceSearch,
} from './sources.js';
import { DOMAINS, EXPERTS, PANELS, expertById, panelById } from './experts.js';

/** Cordis plugin name. */
export const name = 'literature-agents';

/** Services this plugin cannot work without (`web` is optional, resolved lazily). */
export const inject = ['tools', 'systemPrompt', 'subagents', 'agents'];

/** Tools this plugin owns; denied inside summoned children to stop recursion. */
const OWN_TOOLS = ['list_literature_experts', 'summon_literature_expert', 'run_literature_panel'];

/**
 * Every model-facing tool this bundle contributes. The per-conversation toggle
 * denies this whole list on the session's agent context when the feature is off.
 */
const LITERATURE_TOOLS = [
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

/** Route prefix served by the Host half; the composer button calls it. */
const TOGGLE_ROUTE = '/plugins/dsh-literature-agents';

/** Child persona section name and placement (between deployment persona and plan policy). */
const PERSONA_SECTION = 'literature-agents:expert-persona';
const PERSONA_ORDER = 100;

/** Parent guide section name and placement (after team policy, before PTC). */
const GUIDE_SECTION = 'literature-agents:experts';
const GUIDE_ORDER = 700;

/** Defaults for the row `config`. */
const DEFAULTS = {
  provider: 'spawn',
  maxDepth: 1,
};

const DEFAULT_MAX_DEPTH = 1;

/** @param {unknown} value */
function textOf(value) {
  return String(value ?? '');
}

/** @param {unknown} value */
function trimmed(value) {
  return textOf(value).trim();
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(textOf(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** One text content block. @param {string} text */
function textBlock(text) {
  return { type: 'text', text };
}

/** A tool output contract that renders a plain string. */
function stringOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [textBlock(textOf(value))],
  };
}

/**
 * Compile a per-property parameter spec into the raw object JSON Schema the
 * registry projects onto the model-facing tool schema.
 *
 * `ctx.tools.register` stores `definition.parameters` as-is: unlike
 * `defineTool`, it does not compile a flat `{ name: { type, required } }` map.
 * Passing the flat map through produces an invalid function schema (the
 * provider rejects a bare property object where it expects a schema), so the
 * conversion is done here, mirroring `parameterSchemaSpecToJsonSchema`: each
 * `required: true` becomes a key in the root `required` array, and the
 * author-only `json` type becomes an annotation-only schema.
 * @param {Record<string, any>} spec
 */
function parameterSchema(spec) {
  /** @type {Record<string, unknown>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  for (const [key, value] of Object.entries(spec)) {
    const definition = value !== null && typeof value === 'object' ? { ...value } : { type: 'string' };
    const isRequired = definition.required === true;
    delete definition.required;
    if (definition.type === 'json') delete definition.type;
    properties[key] = definition;
    if (isRequired) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

/** Read the row config with defensive defaults. @param {unknown} raw */
function readSettings(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  const provider =
    typeof config.provider === 'string' && config.provider.trim() !== ''
      ? config.provider.trim()
      : DEFAULTS.provider;
  const rawDepth = config.maxDepth;
  const maxDepth =
    Number.isSafeInteger(rawDepth) && rawDepth >= 0 ? rawDepth : DEFAULT_MAX_DEPTH;
  return { provider, maxDepth };
}

/** Normalize a lookup string. @param {unknown} value */
function normalize(value) {
  return textOf(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

/**
 * Resolve a domain key or label.
 * @param {string} query
 * @returns {string | undefined} domain key
 */
function resolveDomain(query) {
  const wanted = normalize(query);
  if (wanted === '') return undefined;
  const hit = DOMAINS.find(
    (domain) =>
      normalize(domain.key) === wanted ||
      normalize(domain.name) === wanted ||
      normalize(domain.nameEn) === wanted ||
      normalize(domain.name).includes(wanted) ||
      normalize(domain.nameEn).includes(wanted),
  );
  return hit?.key;
}

/**
 * Resolve an expert by id, localized name, English name, or alias.
 * @param {string} query
 */
function resolveExpert(query) {
  const wanted = normalize(query);
  if (wanted === '') throw new Error('expert 不能为空；先用 list_literature_experts 查看可用专家。');
  const exact = EXPERTS.find(
    (expert) =>
      normalize(expert.id) === wanted ||
      normalize(expert.name) === wanted ||
      normalize(expert.nameEn) === wanted ||
      (expert.aliases ?? []).some((alias) => normalize(alias) === wanted),
  );
  if (exact !== undefined) return exact;
  const partial = EXPERTS.filter((expert) =>
    [expert.id, expert.name, expert.nameEn, ...(expert.aliases ?? [])].some((candidate) => {
      const value = normalize(candidate);
      return value !== '' && (value.includes(wanted) || wanted.includes(value));
    }),
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `专家名称 "${query}" 匹配到多个：${partial.map((expert) => `${expert.name}(${expert.id})`).join('、')}。请使用精确 id。`,
    );
  }
  throw new Error(
    `未找到专家 "${query}"。可用专家：${EXPERTS.map((expert) => `${expert.name}(${expert.id})`).join('、')}。`,
  );
}

/**
 * Resolve a panel by id, localized name, or English name.
 * @param {string} query
 */
function resolvePanel(query) {
  const wanted = normalize(query);
  if (wanted === '') throw new Error('panel 不能为空；先用 list_literature_experts 查看可用评审团。');
  const exact = PANELS.find(
    (panel) =>
      normalize(panel.id) === wanted ||
      normalize(panel.name) === wanted ||
      normalize(panel.nameEn) === wanted,
  );
  if (exact !== undefined) return exact;
  const partial = PANELS.filter((panel) =>
    [panel.id, panel.name, panel.nameEn].some((candidate) => {
      const value = normalize(candidate);
      return value !== '' && (value.includes(wanted) || wanted.includes(value));
    }),
  );
  if (partial.length === 1) return partial[0];
  throw new Error(
    `未找到评审团 "${query}"。可用评审团：${PANELS.map((panel) => `${panel.name}(${panel.id})`).join('、')}。`,
  );
}

/** Render the compact catalog. @param {string | undefined} domainKey */
function renderCatalog(domainKey) {
  const domains =
    domainKey === undefined ? DOMAINS : DOMAINS.filter((domain) => domain.key === domainKey);
  if (domains.length === 0) return '没有匹配的领域。';
  const lines = [`文学与古典文献专家（共 ${EXPERTS.length} 位，${DOMAINS.length} 个领域）：`];
  for (const domain of domains) {
    const members = EXPERTS.filter((expert) => expert.domain === domain.key);
    if (members.length === 0) continue;
    lines.push('', `[${domain.name} / ${domain.key}] ${members.length} 位`);
    for (const expert of members) {
      lines.push(`- ${expert.name} (${expert.id})：${expert.focus}`);
    }
  }
  lines.push(
    '',
    `评审团 ${PANELS.length} 个：${PANELS.map((panel) => `${panel.name}(${panel.id})`).join('、')}。`,
    '用 summon_literature_expert 召唤单个专家，用 run_literature_panel 运行评审团。',
  );
  return lines.join('\n');
}

/** The standing parent-side guide. */
function guideText() {
  const byDomain = DOMAINS.map((domain) => {
    const names = EXPERTS.filter((expert) => expert.domain === domain.key)
      .map((expert) => `${expert.name}(${expert.id})`)
      .join('、');
    return `- ${domain.name}：${names}`;
  }).join('\n');
  const panels = PANELS.map((panel) => `- ${panel.name}(${panel.id})：${panel.description}`).join('\n');
  return `## 文学与古典文献专家（literature-agents）

可用专家（中西兼顾，以中国古典文献为主）：
${byDomain}

可用评审团：
${panels}

文献工具（回答涉及论文、生平、古籍原文、译文或引文时，先调用对应工具取真实数据）：
- search_scholar_papers：检索论文（Crossref / OpenAlex，网页搜索兜底）
- get_scholar_biography：查学者生平（Wikidata 权威字段）
- search_classic_texts / get_classic_text：检索并读取古籍全文（中文维基文库）
- translate_classic：检索平行文本与旧注后，由古籍翻译家给出今译/英译
- verify_citation：核验一条引文是否真实存在（DOI/题名比对）

使用规则：
1. 凡涉及论文、生平、古籍原文、译文、参考文献，先调用工具；禁止仅凭记忆断言，禁止编造论文、作者、卷次或原文。
2. 工具输出会标注数据源及失败情况。只把已返回结果当作事实；未检得就明确写“未检得”，并给出最小核实路径。
3. 用户点名专家或需要专业视角时，直接调用 summon_literature_expert，不要先自己分析；多视角审查用 run_literature_panel。
4. 编辑或审校论文、书稿、译文前，先加载 \`literature-research\` 技能，按其中的核验、引用与翻译规范执行。
5. 专家是独立子代理，看不到本会话，task 必须自包含：目标、材料原文、版本信息、约束、期望输出。
6. 每条引文给出 DOI、URL 或卷页；无法核实的标注“待确认”，不要用“应该”“可能是”掩盖。`;
}

/**
 * Build the first user message for a summoned child. The full persona goes into
 * the child's system prompt through `agent/created`; this text restates the role
 * in one line, then adds the task and the recursion prohibition.
 * @param {{ name: string, nameEn: string }} expert
 * @param {string} task
 * @param {string | undefined} instruction
 */
function childPrompt(expert, task, instruction) {
  const parts = [
    `你是「${expert.name}」（${expert.nameEn}）。请独立完成下面的任务，不要调用其他专家或评审团，也不要假设自己看到了主会话的对话或项目内容。`,
    '',
    '任务：',
    task,
  ];
  if (instruction !== undefined && instruction.trim() !== '') {
    parts.push('', '补充要求：', instruction.trim());
  }
  return parts.join('\n');
}

/**
 * Resolve the subagent provider. Defaults to `spawn` and falls back to any
 * registered non-fork provider when `spawn` is absent.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ provider: string }} settings
 */
function resolveProvider(ctx, settings) {
  const registered = ctx.subagents.list();
  if (settings.provider !== '') {
    if (registered.includes(settings.provider)) return settings.provider;
    throw new Error(
      `subagent provider "${settings.provider}" 未注册。可用 provider：${registered.join('、') || '(无)'}。请在插件行 config 中修改 provider。`,
    );
  }
  if (registered.includes('spawn')) return 'spawn';
  const fallback = registered.find((entry) => entry !== 'fork');
  if (fallback !== undefined) return fallback;
  throw new Error(`没有可用的子代理 provider（已注册：${registered.join('、') || '无'}）。`);
}

/**
 * Install the child persona and delegation restriction when the reserved child
 * agent is created. The listener is disposed as soon as the activation starts.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} childId
 * @param {{ persona: string }} expert
 */
function installChildPersona(ctx, childId, expert) {
  return ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== childId) return;
    if (agent.ctx === undefined) return;
    try {
      const childCtx = agent.ctx;
      if (childCtx === undefined) return;
      childCtx.effect(() => {
        /** @type {Array<() => void>} */
        const disposers = [];
        try {
          if (childCtx.systemPrompt !== undefined) {
            disposers.push(
              childCtx.systemPrompt.section({
                name: PERSONA_SECTION,
                order: PERSONA_ORDER,
                text: expert.persona,
              }),
            );
          }
          if (childCtx.tools !== undefined) {
            disposers.push(childCtx.tools.restrict({ deny: OWN_TOOLS }));
          }
        } catch {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              /* a partially installed child registration is still disposable */
            }
          }
        }
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              /* teardown must not mask the run outcome */
            }
          }
        };
      });
    } catch {
      /* persona injection is best-effort; the child still gets its role line */
    }
  });
}

/**
 * Race an activation's result against caller cancellation, and dispose the
 * activation exactly once.
 * @param {any} activation
 * @param {AbortSignal} signal
 */
async function awaitActivation(activation, signal) {
  let rejectAborted;
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    rejectAborted = reject;
  });
  // Mark the activation result handled even when cancellation wins the race.
  activation.result.catch(() => {});
  if (signal.aborted) {
    rejectAborted(signal.reason ?? new Error('已取消'));
  } else {
    onAbort = () => rejectAborted(signal.reason ?? new Error('已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await Promise.race([activation.result, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Extract the text answer from a subagent result, refusing to report a
 * non-completed run as a conclusion.
 * @param {any} result
 */
function expertResultText(result) {
  const text = (result.output ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (result.stopReason !== 'completed') {
    const detail = text === '' ? '' : `\n\n已有输出：\n${text}`;
    const diagnostic = result.diagnostic === undefined ? '' : `\n诊断：${result.diagnostic}`;
    throw new Error(`专家运行未完成（${result.stopReason}）。${diagnostic}${detail}`);
  }
  return text === '' ? '（专家未返回文本内容）' : text;
}

/**
 * Start one expert child, wait for it, release it, and return its text answer.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ provider: string, maxDepth: number }} settings
 * @param {{ id: string, name: string, nameEn: string, persona: string }} expert
 * @param {string} task
 * @param {string | undefined} instruction
 * @param {{ agent: any, signal: AbortSignal }} exec
 */
async function runExpertChild(ctx, settings, expert, task, instruction, exec) {
  const parent = exec.agent;
  if (parent === undefined || parent === null) {
    throw new Error('该工具需要一个调用它的主 Agent（exec.agent 为空）。');
  }
  if (exec.signal.aborted) throw exec.signal.reason ?? new Error('已取消');
  const provider = resolveProvider(ctx, settings);
  const providerInfo = ctx.subagents.getProvider(provider);
  const supportsDepth = providerInfo?.capabilities?.depthLimit === true;
  const childId = randomUUID();
  const stopListening = installChildPersona(ctx, childId, expert);
  let activation;
  try {
    activation = await ctx.subagents.startActivation({
      provider,
      label: expert.name,
      childId,
      request: {
        parent,
        prompt: [textBlock(childPrompt(expert, task, instruction))],
        ...(supportsDepth ? { maxDepth: settings.maxDepth } : {}),
      },
      signal: exec.signal,
      delivery: 'caller',
    });
  } finally {
    if (typeof stopListening === 'function') stopListening();
  }
  try {
    const result = await awaitActivation(activation, exec.signal);
    return expertResultText(result);
  } finally {
    await activation.dispose().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Source reporting helpers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} reason
 * @returns {string}
 */
function failureDetail(reason) {
  if (reason instanceof SourceUnavailable) return reason.detail;
  if (reason instanceof Error) return reason.message;
  return textOf(reason);
}

/**
 * @param {Array<{ source: string, ok: boolean, detail?: string }>} entries
 */
function renderSourceReport(entries) {
  if (entries.length === 0) return '数据源：无';
  const parts = entries.map((entry) =>
    entry.ok ? `${entry.source} ✓` : `${entry.source} ✗（${entry.detail ?? '失败'}）`,
  );
  return `数据源：${parts.join(' ｜ ')}`;
}

/** @param {number} index @param {import('./sources.js').Paper} paper */
function formatPaper(index, paper) {
  const lines = [`${index}. ${paper.title}`];
  const meta = [];
  if (paper.authors.length > 0) {
    const shown = paper.authors.slice(0, 6).join('、');
    meta.push(`作者：${shown}${paper.authors.length > 6 ? ' 等' : ''}`);
  }
  if (paper.year !== undefined) meta.push(`年份：${paper.year}`);
  if (paper.venue !== undefined && paper.venue !== '') meta.push(`刊物/出版：${paper.venue}`);
  if (paper.type !== undefined && paper.type !== '') meta.push(`类型：${paper.type}`);
  if (meta.length > 0) lines.push(`   ${meta.join(' ｜ ')}`);
  const links = [];
  if (paper.doi !== undefined && paper.doi !== '') links.push(`DOI：${paper.doi}`);
  if (paper.url !== undefined && paper.url !== '') links.push(`链接：${paper.url}`);
  links.push(`来源：${paper.source}`);
  lines.push(`   ${links.join(' ｜ ')}`);
  return lines.join('\n');
}

/** @param {number} index @param {import('./sources.js').WebHit} hit */
function formatWebHit(index, hit) {
  const lines = [`W${index}. ${hit.title ?? '(无标题)'}`, `   ${hit.url}`];
  if (hit.snippet !== undefined && hit.snippet !== '') lines.push(`   摘要：${hit.snippet}`);
  if (hit.publishedAt !== undefined) lines.push(`   发布：${hit.publishedAt}`);
  return lines.join('\n');
}

/** ISO timestamp of the moment the answer was assembled. */
function nowStamp() {
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Locate this package's own `skills/literature-research` directory so the
 * skill-filesystem row can mount it without a hard-coded path.
 */
function resolveSkillsDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = existsSync(join(here, 'package.json')) ? here : dirname(here);
  return join(root, 'skills', 'literature-research');
}

/* -------------------------------------------------------------------------- */
/* Per-conversation availability                                              */
/* -------------------------------------------------------------------------- */

/**
 * The plugin is available in every conversation unless this map says otherwise.
 * Only an explicit `false` disables it, so a new session inherits "on".
 * @type {Map<string, boolean>}
 */
const toggleStates = new Map();
let toggleStatesLoaded = false;

/**
 * One installed gate per live Agent. A gate is either the standing guide section
 * (enabled) or the tool restriction (disabled); disposing its registrations is
 * how a toggle takes effect immediately.
 * @type {Map<string, { enabled: boolean, disposers: Array<() => void> }>}
 */
const sessionGates = new Map();

/** Where the per-session choices survive a restart. */
function toggleStatePath() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh');
  return join(home, 'dsh-literature-agents', 'toggles.json');
}

function loadToggleStates() {
  if (toggleStatesLoaded) return;
  toggleStatesLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(toggleStatePath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean' && /^[A-Za-z0-9_-]{1,128}$/.test(key)) {
        toggleStates.set(key, value);
      }
    }
  } catch {
    /* first run: no saved choices yet */
  }
}

function persistToggleStates() {
  try {
    const file = toggleStatePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(Object.fromEntries(toggleStates), null, 2)}\n`, 'utf8');
  } catch {
    /* the choice still holds for this process; persistence is best effort */
  }
}

/** @param {string} sessionId */
function isEnabledFor(sessionId) {
  loadToggleStates();
  return toggleStates.get(sessionId) !== false;
}

/** @param {string} sessionId @param {boolean} enabled */
function setEnabledFor(sessionId, enabled) {
  loadToggleStates();
  toggleStates.set(sessionId, enabled);
  persistToggleStates();
}

/** Remove whatever the session's gate installed. @param {string} sessionId */
function disposeGate(sessionId) {
  const gate = sessionGates.get(sessionId);
  if (gate === undefined) return;
  sessionGates.delete(sessionId);
  for (const dispose of gate.disposers.reverse()) {
    try {
      dispose();
    } catch {
      /* teardown must not mask the toggle outcome */
    }
  }
}

/**
 * Install the current choice on one live Agent.
 *
 * Enabled: the standing guide section is registered on the Agent's own context,
 * so the model is told the literature tools exist.
 * Disabled: the guide is gone and `tools.restrict()` hides all nine tools from
 * that Agent only — schema presentation, lookup and execution stay aligned.
 * @param {{ id: string, ctx?: any }} agent
 * @param {boolean} enabled
 */
function applyGate(agent, enabled) {
  const sessionId = typeof agent?.id === 'string' ? agent.id : '';
  const agentCtx = agent?.ctx;
  if (sessionId === '' || agentCtx === undefined || agentCtx === null) return;
  disposeGate(sessionId);
  /** @type {Array<() => void>} */
  const disposers = [];
  try {
    if (enabled) {
      if (agentCtx.systemPrompt !== undefined) {
        disposers.push(
          agentCtx.systemPrompt.section({
            name: GUIDE_SECTION,
            order: GUIDE_ORDER,
            text: guideText(),
          }),
        );
      }
    } else if (agentCtx.tools !== undefined) {
      disposers.push(agentCtx.tools.restrict({ deny: LITERATURE_TOOLS }));
    }
  } catch {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* a partially installed gate is still disposable */
      }
    }
    return;
  }
  sessionGates.set(sessionId, { enabled, disposers });
}

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** @param {import('node:http').IncomingMessage} req */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * Serve the two routes the composer button uses. The button is the only caller:
 * flipping availability is a user act, not an agent act, so no tool exposes it.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function registerToggleRoutes(ctx) {
  /** @param {{ register: Function }} server */
  const install = (server) => {
    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: `${TOGGLE_ROUTE}/state`,
          handler: (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'GET only' });
              return;
            }
            const url = new URL(req.url ?? '/', 'http://localhost');
            const sessionId = url.searchParams.get('session') ?? '';
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
              sendJson(res, 400, { error: 'invalid session id' });
              return;
            }
            sendJson(res, 200, { sessionId, enabled: isEnabledFor(sessionId) });
          },
        }),
      'literature-agents: state route',
    );
    ctx.effect(
      () =>
        server.register({
          kind: 'exact',
          path: `${TOGGLE_ROUTE}/toggle`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'POST only' });
              return;
            }
            const body = await readJsonBody(req);
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
              sendJson(res, 400, { error: 'invalid session id' });
              return;
            }
            const next =
              typeof body?.enabled === 'boolean' ? body.enabled : !isEnabledFor(sessionId);
            setEnabledFor(sessionId, next);
            // `probe: true` is a read-only diagnostic used while developing the
            // switch; it reports whether the gate reached the live Agent and
            // whether the Agent's visible tool schemas still include the bundle.
            let agentFound = false;
            let literatureVisible;
            let agentService = false;
            let agentCount = -1;
            try {
              agentService =
                ctx.agents !== undefined &&
                ctx.agents !== null &&
                typeof ctx.agents.get === 'function';
              if (typeof ctx.agents?.list === 'function') agentCount = ctx.agents.list().length;
              const agent = ctx.agents.get(sessionId);
              if (agent !== undefined && agent !== null) {
                agentFound = true;
                applyGate(agent, next);
                if (typeof ctx.tools.schemas === 'function') {
                  literatureVisible = ctx.tools
                    .schemas(agent)
                    .some((schema) => schema.name === 'list_literature_experts');
                }
              }
            } catch {
              /* the choice is saved; the live Agent is refreshed if still present */
            }
            sendJson(res, 200, {
              sessionId,
              enabled: next,
              ...(body?.probe === true ? { agentFound, literatureVisible, agentService, agentCount } : {}),
            });
          },
        }),
      'literature-agents: toggle route',
    );
  };

  const direct = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (direct !== undefined && direct !== null) {
    install(direct);
    return;
  }
  try {
    ctx.inject(['webServer'], (scope) => {
      let server;
      try {
        server =
          scope !== null && scope !== undefined && typeof scope.get === 'function'
            ? scope.get('webServer')
            : undefined;
      } catch {
        server = undefined;
      }
      if (server === undefined && scope !== null && scope !== undefined) {
        server = scope.webServer;
      }
      if (server !== undefined && server !== null) install(server);
    });
  } catch {
    /* no web server in this composition: the tools still work, the button is absent */
  }
}

/**
 * Install the model-facing tools, the standing guide and the skills service.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const settings = readSettings(rawConfig);
  /**
   * Register one tool. `parameters` is already compiled into raw JSON Schema by
   * `parameterSchema`, because `ctx.tools.register` stores the property map
   * verbatim and the model adapter would reject the authoring spec.
   */
  const registerTool = (definition) => ctx.tools.register(definition);

  /* ---- 0. Per-conversation availability ---------------------------------- */

  loadToggleStates();
  ctx.effect(
    () => () => {
      for (const sessionId of [...sessionGates.keys()]) disposeGate(sessionId);
    },
    'literature-agents: session gates',
  );
  // A session created while the feature is off must not see the tools or the
  // guide; `agent/created` is where a live Agent's own context becomes reachable.
  ctx.on('agent/created', ({ agent }) => {
    try {
      applyGate(agent, isEnabledFor(agent.id));
    } catch {
      /* the agent keeps the root registration; a toggle can retry later */
    }
  });
  registerToggleRoutes(ctx);
  try {
    for (const agent of ctx.agents.list()) {
      try {
        applyGate(agent, isEnabledFor(agent.id));
      } catch {
        /* skip agents that are already disposing */
      }
    }
  } catch {
    /* no live agents yet at activation time */
  }

  ctx.provide('literatureSkills', {
    skillsDir: resolveSkillsDir(),
  });

  /* ---- 1. Roster -------------------------------------------------------- */

  registerTool({
    name: 'list_literature_experts',
    description:
      'List the built-in literature / classical-scholarship experts, optionally filtered by domain. Returns names, stable ids, one-line angles, and the review panels. Call this before summon_literature_expert when unsure which expert fits.',
    parameters: parameterSchema({
      domain: {
        type: 'string',
        description: `Optional domain filter. One of: ${DOMAINS.map((domain) => `${domain.key} (${domain.name})`).join(', ')}.`,
      },
    }),
    output: stringOutput(),
    async execute(args) {
      const domainQuery = typeof args?.domain === 'string' ? args.domain : '';
      const domainKey = resolveDomain(domainQuery);
      if (domainQuery.trim() !== '' && domainKey === undefined) {
        throw new Error(
          `未知领域 "${domainQuery}"。可用领域：${DOMAINS.map((domain) => `${domain.key} (${domain.name})`).join('、')}。`,
        );
      }
      return renderCatalog(domainKey);
    },
  });

  registerTool({
    name: 'summon_literature_expert',
    description:
      "Summon one literature / classical-scholarship expert: starts a specialist subagent with that expert's full persona, waits for its answer, and returns it. Use it when the user names an expert or asks for a focused specialist analysis instead of doing the work yourself. The expert cannot see this conversation, so `task` must be self-contained: goal, materials (quote the text), edition/version if known, constraints, and expected output.",
    parameters: parameterSchema({
      expert: {
        type: 'string',
        required: true,
        description:
          'Expert id, Chinese name, English name, or alias (for example "textual-critic", "校勘学家", "Textual Critic"). Call list_literature_experts when unsure.',
      },
      task: {
        type: 'string',
        required: true,
        description:
          'Complete, self-contained task for the expert. Include the goal, the quoted materials, edition/version information, constraints, and the expected output shape. Do not rely on the expert seeing this conversation.',
      },
    }),
    output: stringOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const expert = resolveExpert(textOf(args?.expert));
      const task = trimmed(args?.task);
      if (task === '') throw new Error('task 不能为空：专家看不到本会话，必须提供完整任务。');
      const answer = await runExpertChild(ctx, settings, expert, task, undefined, exec);
      return `【专家】${expert.name}（${expert.nameEn}）\n\n${answer}`;
    },
  });

  registerTool({
    name: 'run_literature_panel',
    description:
      'Run one built-in literature review panel: every member expert independently reviews the same artifact from its own angle in parallel, and all opinions return together. Use it for multi-angle review of a paper, manuscript, translation, or textual/edition question. After it returns, verify the evidence, deduplicate findings, rank severity, and deliver the unified review yourself; member opinions are input, not final conclusions. `task` must be self-contained because panel members cannot see this conversation.',
    parameters: parameterSchema({
      panel: {
        type: 'string',
        required: true,
        description: `Panel id or name. One of: ${PANELS.map((panel) => `${panel.id} (${panel.name})`).join(', ')}.`,
      },
      task: {
        type: 'string',
        required: true,
        description:
          'Complete, self-contained artifact and review request shared by every member: goal, quoted materials, edition/version, constraints, and the expected output shape.',
      },
    }),
    output: stringOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const panel = resolvePanel(textOf(args?.panel));
      const task = trimmed(args?.task);
      if (task === '') throw new Error('task 不能为空：评审团成员看不到本会话，必须提供完整材料。');
      const members = panel.members.map((id) => expertById(id)).filter(Boolean);
      if (members.length === 0) throw new Error(`评审团 "${panel.name}" 没有有效成员。`);
      const outcomes = await Promise.allSettled(
        members.map((expert) => runExpertChild(ctx, settings, expert, task, panel.instruction, exec)),
      );
      const sections = [];
      let succeeded = 0;
      for (let index = 0; index < members.length; index += 1) {
        const expert = members[index];
        const outcome = outcomes[index];
        if (outcome.status === 'fulfilled') {
          succeeded += 1;
          sections.push(`===== ${expert.name}（${expert.id}）=====\n${outcome.value}`);
        } else {
          const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          sections.push(`===== ${expert.name}（${expert.id}）=====\n[成员失败] ${message}`);
        }
      }
      if (succeeded === 0) {
        throw new Error(`评审团 "${panel.name}" 的全部成员均失败：\n\n${sections.join('\n\n')}`);
      }
      return [
        `【评审团】${panel.name}（${panel.id}）— ${succeeded}/${members.length} 位成员返回结果`,
        `说明：${panel.description}`,
        '',
        ...sections.flatMap((section) => [section, '']),
        '【汇总要求】以上是成员的独立意见，不是最终结论。请由主会话核验证据、合并重复项、按严重级别排序后统一交付；无法验证的内容标注为待确认。',
      ].join('\n');
    },
  });

  /* ---- 2. Scholarly papers and biographies ------------------------------ */

  registerTool({
    name: 'search_scholar_papers',
    description:
      'Search real scholarly papers by topic and/or author through Crossref and OpenAlex (structured metadata with DOI), with host web search as a labelled fallback when the structured sources fail or return nothing. Returns titles, authors, year, venue, DOI and links. Use it instead of recalling papers from memory; never invent a citation.',
    parameters: parameterSchema({
      query: {
        type: 'string',
        description: 'Topic, title, or keyword string, e.g. "明清史学 私家修史" or "Chinese historiography Ming dynasty".',
      },
      author: {
        type: 'string',
        description:
          'Author name. Chinese names index poorly in Crossref/OpenAlex; also pass a romanized name when possible (e.g. "余英时" plus "Yu Ying-shih").',
      },
      yearFrom: {
        type: 'number',
        description: 'Optional earliest publication year (inclusive).',
      },
      yearTo: {
        type: 'number',
        description: 'Optional latest publication year (inclusive).',
      },
      limit: {
        type: 'number',
        description: 'Maximum results to return, 1-20 (default 8).',
      },
      includeWeb: {
        type: 'string',
        description: 'Web fallback policy: "auto" (default, only when structured sources return nothing), "web" (always), "off".',
      },
    }),
    output: stringOutput(),
    async execute(args, exec) {
      const query = trimmed(args?.query);
      const author = trimmed(args?.author);
      if (query === '' && author === '') {
        throw new Error('query 与 author 至少提供一个。');
      }
      const limit = clampNumber(args?.limit, 8, 1, 20);
      const yearFrom = Number.isFinite(Number(args?.yearFrom)) ? Number(args.yearFrom) : undefined;
      const yearTo = Number.isFinite(Number(args?.yearTo)) ? Number(args.yearTo) : undefined;
      const policy = ['auto', 'web', 'off'].includes(trimmed(args?.includeWeb))
        ? trimmed(args?.includeWeb)
        : 'auto';
      const searchText = [query, author].filter((part) => part !== '').join(' ');

      const tasks = [];
      const labels = [];
      tasks.push(
        searchCrossref({ query, author, yearFrom, yearTo, rows: limit + 2, signal: exec.signal }),
      );
      labels.push('Crossref');
      tasks.push(searchOpenAlex({ query: searchText, perPage: limit + 2, signal: exec.signal }));
      labels.push('OpenAlex');
      if (author !== '') {
        tasks.push(findOpenAlexAuthorWorks({ name: author, limit: limit + 2, signal: exec.signal }));
        labels.push('OpenAlex 作者作品');
      }

      const settled = await Promise.allSettled(tasks);
      /** @type {Array<{ source: string, ok: boolean, detail?: string }>} */
      const report = [];
      const groups = [];
      settled.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') {
          report.push({ source: labels[index], ok: true });
          const value = outcome.value;
          if (Array.isArray(value)) groups.push(value);
          else if (Array.isArray(value?.works)) groups.push(value.works);
        } else {
          report.push({ source: labels[index], ok: false, detail: failureDetail(outcome.reason) });
        }
      });

      let papers = mergePapers(groups);
      if (yearFrom !== undefined) papers = papers.filter((paper) => (paper.year ?? 0) >= yearFrom);
      if (yearTo !== undefined) papers = papers.filter((paper) => (paper.year ?? 9999) <= yearTo);

      let webHits = [];
      const needWeb = policy === 'web' || (policy === 'auto' && papers.length === 0);
      if (needWeb) {
        try {
          webHits = await webSearch(ctx, {
            query: `${searchText} 学术论文 期刊`,
            maxResults: 6,
            signal: exec.signal,
          });
          report.push({ source: '网页搜索', ok: true });
        } catch (error) {
          report.push({ source: '网页搜索', ok: false, detail: failureDetail(error) });
        }
      }

      const trimmedPapers = papers.slice(0, limit);
      const lines = [
        `【论文检索】${searchText}${yearFrom !== undefined || yearTo !== undefined ? `（${yearFrom ?? ''}-${yearTo ?? ''}）` : ''}`,
        renderSourceReport(report),
        `检索时间：${nowStamp()} ｜ 结构化记录 ${papers.length} 条，返回 ${trimmedPapers.length} 条${webHits.length > 0 ? `，网页线索 ${webHits.length} 条` : ''}`,
      ];
      if (trimmedPapers.length === 0 && webHits.length === 0) {
        lines.push(
          '',
          '未检得匹配记录。可尝试：放宽年份、改用英文/拼音作者名、减少关键词，或改用 search_classic_texts 查原始文献。',
        );
        return lines.join('\n');
      }
      if (trimmedPapers.length > 0) {
        lines.push('', '结构化记录（DOI 可直接核验）：');
        lines.push(...trimmedPapers.map((paper, index) => formatPaper(index + 1, paper)));
      }
      if (webHits.length > 0) {
        lines.push(
          '',
          '网页线索（仅作检索线索，未核验；须逐条用 DOI/馆藏或原文核对后才能引用）：',
          ...webHits.map((hit, index) => formatWebHit(index + 1, hit)),
        );
      }
      lines.push(
        '',
        '提示：以上为数据库返回的元数据，引用前请核对作者、年份、卷期页；需要逐条核验时调用 verify_citation。',
      );
      return lines.join('\n');
    },
  });

  registerTool({
    name: 'get_scholar_biography',
    description:
      "Look up a scholar's or historical figure's biography from Wikidata (birth/death, places, occupations, fields, education, employers, awards, notable works) and list their works through OpenAlex. Each fact carries its Wikidata property id, and unresolved candidates are listed so the user can disambiguate. Use it for 生平 questions; do not write biographies from memory.",
    parameters: parameterSchema({
      name: {
        type: 'string',
        required: true,
        description: 'Person name in Chinese or English, e.g. "司马迁", "陈寅恪", "Yu Ying-shih".',
      },
      qid: {
        type: 'string',
        description: 'Optional exact Wikidata item id (e.g. "Q9372") to skip the entity search when the name is ambiguous.',
      },
      includeWorks: {
        type: 'string',
        description: 'Whether to list the person\'s works via OpenAlex: "true" (default) or "false".',
      },
    }),
    output: stringOutput(),
    async execute(args, exec) {
      const personName = trimmed(args?.name);
      const qidArg = trimmed(args?.qid);
      const includeWorks = trimmed(args?.includeWorks) !== 'false';
      if (personName === '' && qidArg === '') throw new Error('name 不能为空。');
      if (qidArg !== '' && !/^Q\d+$/.test(qidArg)) throw new Error('qid 形如 Q9372。');

      const report = [];
      /** @type {Array<{ id: string, label: string, description?: string }>} */
      let candidates = [];
      let entity;
      let ambiguityNotice;
      try {
        if (qidArg !== '') {
          entity = await wikidataEntity({ qid: qidArg, signal: exec.signal });
          report.push({ source: 'Wikidata', ok: true });
        } else {
          candidates = await wikidataSearch({ name: personName, limit: 5, signal: exec.signal });
          report.push({ source: 'Wikidata 实体检索', ok: true });
          if (candidates.length === 0) {
            throw new SourceUnavailable('wikidata', `未检得实体「${personName}」`);
          }
          const exact = candidates.find((candidate) => candidate.label === personName);
          const chosen = exact ?? candidates[0];
          entity = await wikidataEntity({ qid: chosen.id, signal: exec.signal });
          report.push({ source: 'Wikidata 实体数据', ok: true });
          const moreExact = candidates.filter(
            (candidate) => candidate.label === chosen.label && candidate.id !== chosen.id,
          );
          if (chosen.label === personName && moreExact.length > 0) {
            ambiguityNotice = `同名候选 ${moreExact.length + 1} 个，已取 ${chosen.id}；若不是目标人物，请用 qid 精确指定。`;
          } else if (exact === undefined) {
            ambiguityNotice = `未找到与「${personName}」完全同名的实体，已取最接近的 ${chosen.id}（${chosen.label}）；请核对，必要时用 qid 指定。`;
          }
        }
      } catch (error) {
        report.push({ source: 'Wikidata', ok: false, detail: failureDetail(error) });
      }

      if (entity === undefined) {
        let hits = [];
        try {
          hits = await webSearch(ctx, {
            query: `${personName} 生平 年谱 传记`,
            maxResults: 6,
            signal: exec.signal,
          });
          report.push({ source: '网页搜索', ok: true });
        } catch (error) {
          report.push({ source: '网页搜索', ok: false, detail: failureDetail(error) });
        }
        return [
          `【学人生平】${personName}`,
          renderSourceReport(report),
          'Wikidata 查询失败，以下仅为网页线索，未核验，不能作为生平事实直接引用：',
          '',
          ...(hits.length > 0
            ? hits.map((hit, index) => formatWebHit(index + 1, hit))
            : ['未检得可用线索。请改用 verify_citation 或直接查询权威工具书。']),
        ].join('\n');
      }

      const person = await summarizePerson({ entity, signal: exec.signal });
      const lines = [`【学人生平】${person.label}（${person.qid}）`, renderSourceReport(report), ''];
      if (ambiguityNotice !== undefined) lines.push(`提示：${ambiguityNotice}`, '');

      const authority = [`Wikidata：${person.wikidataUrl}`];
      if (person.wikipediaUrl !== undefined) authority.push(`维基百科：${person.wikipediaUrl}（本机网络可能不可达，仅作引用地址）`);
      if (person.wikisourceUrl !== undefined) authority.push(`维基文库作者页：${person.wikisourceUrl}`);
      lines.push('权威链接：', ...authority.map((item) => `- ${item}`));
      lines.push('');

      /** @param {string} label @param {string | undefined} value @param {string} [property] */
      const fact = (label, value, property) => {
        if (value === undefined || value === '') return;
        lines.push(`- ${label}：${value}${property === undefined ? '' : `（${property}）`}`);
      };
      fact('描述', person.description);
      fact('本名/别名', person.nativeName ?? (person.aliases.length > 0 ? person.aliases.join('、') : undefined));
      const lifespan = [person.birth, person.death].filter(Boolean).join(' — ');
      fact('生卒', lifespan === '' ? undefined : lifespan, 'P569/P570');
      fact('出生地', person.birthPlace, 'P19');
      fact('卒地', person.deathPlace, 'P20');
      fact('身份/职业', person.occupations.length > 0 ? person.occupations.join('、') : undefined, 'P106');
      fact('研究领域', person.fields.length > 0 ? person.fields.join('、') : undefined, 'P101');
      fact('教育', person.education.length > 0 ? person.education.join('、') : undefined, 'P69');
      fact('任职', person.employers.length > 0 ? person.employers.join('、') : undefined, 'P108');
      fact('奖项', person.awards.length > 0 ? person.awards.join('、') : undefined, 'P166');
      fact('代表作', person.notableWorks.length > 0 ? person.notableWorks.join('、') : undefined, 'P800');

      if (includeWorks) {
        try {
          const result = await findOpenAlexAuthorWorks({
            name: person.label !== '' ? person.label : personName,
            limit: 8,
            signal: exec.signal,
          });
          lines.push('', '著作/论文（OpenAlex 自动匹配，可能并非同一人，须核对）：');
          if (result.works.length === 0) {
            lines.push('- 未检得。中文姓名在 OpenAlex 多以拼音收录，可改用拼音/英文名再查。');
          } else {
            lines.push(...result.works.map((paper, index) => formatPaper(index + 1, paper)));
          }
        } catch (error) {
          lines.push('', `著作/论文：OpenAlex 不可用（${failureDetail(error)}）。`);
        }
      }

      if (candidates.length > 1) {
        lines.push(
          '',
          '同名/相关候选（若上方并非目标人物，请用 qid 精确指定）：',
          ...candidates.map(
            (candidate) =>
              `- ${candidate.label}（${candidate.id}）${candidate.description === undefined ? '' : `：${candidate.description}`}`,
          ),
        );
      }
      lines.push('', '说明：生卒、籍贯等字段来自 Wikidata 声明，可能不完整或存在异说；写入正式文稿前请再核对年谱、传记或墓志。');
      return lines.join('\n');
    },
  });

  /* ---- 3. Classical texts ------------------------------------------------ */

  registerTool({
    name: 'search_classic_texts',
    description:
      'Full-text search classical Chinese texts in Chinese Wikisource (zh.wikisource.org): 二十四史、诸子、文集、佛典等. Returns page titles, plain-text snippets, and article URLs. Use it to find the source of a quotation, an edition, or a parallel passage. Falls back to host web search (labelled as leads) only when Wikisource is unreachable.',
    parameters: parameterSchema({
      query: {
        type: 'string',
        description: 'Search expression, e.g. "项羽本纪 鸿门宴", "史记 淮阴侯列传", "文心雕龙 神思".',
      },
      limit: {
        type: 'number',
        description: 'Maximum hits, 1-20 (default 8).',
      },
    }),
    output: stringOutput(),
    async execute(args, exec) {
      const query = trimmed(args?.query);
      if (query === '') throw new Error('query 不能为空。');
      const limit = clampNumber(args?.limit, 8, 1, 20);
      const report = [];
      let hits = [];
      try {
        hits = await wikisourceSearch({ query, limit, signal: exec.signal });
        report.push({ source: '中文维基文库', ok: true });
      } catch (error) {
        report.push({ source: '中文维基文库', ok: false, detail: failureDetail(error) });
      }
      if (hits.length === 0) {
        try {
          const fallback = await webSearch(ctx, {
            query: `site:zh.wikisource.org ${query}`,
            maxResults: limit,
            signal: exec.signal,
          });
          report.push({ source: '网页搜索', ok: true });
          if (fallback.length > 0) {
            return [
              `【古籍检索】${query}`,
              renderSourceReport(report),
              '维基文库未直接命中，以下为网页线索（未核验）：',
              '',
              ...fallback.map((hit, index) => formatWebHit(index + 1, hit)),
            ].join('\n');
          }
        } catch (error) {
          report.push({ source: '网页搜索', ok: false, detail: failureDetail(error) });
        }
      }
      const lines = [
        `【古籍检索】${query}`,
        renderSourceReport(report),
        `检索时间：${nowStamp()} ｜ 命中 ${hits.length} 条`,
      ];
      if (hits.length === 0) {
        lines.push('', '未检得。可尝试换用书名、篇名或原文中的连续字串（维基文库全文检索对长句更敏感）。');
        return lines.join('\n');
      }
      lines.push('');
      hits.forEach((hit, index) => {
        lines.push(`${index + 1}. ${hit.title}`, `   ${hit.url}`);
        if (hit.snippet !== '') lines.push(`   摘要：${hit.snippet}`);
      });
      lines.push('', '下一步：用 get_classic_text 读取命中的页面全文（可能需要按卷拆分阅读）。');
      return lines.join('\n');
    },
  });

  registerTool({
    name: 'get_classic_text',
    description:
      'Read one page from Chinese Wikisource as plain text: strips wikitext templates, references, links and tables, and truncates to a safe length. Use it after search_classic_texts to read the actual passage before quoting or translating. The returned text is the raw source; it may contain OCR/variant-character issues.',
    parameters: parameterSchema({
      title: {
        type: 'string',
        required: true,
        description: 'Exact Wikisource page title, e.g. "史記/卷007" or "Author:司馬遷".',
      },
      maxChars: {
        type: 'number',
        description: 'Maximum characters to return, 500-30000 (default 8000).',
      },
    }),
    output: stringOutput(),
    async execute(args, exec) {
      const title = trimmed(args?.title);
      if (title === '') throw new Error('title 不能为空。');
      const maxChars = clampNumber(args?.maxChars, 8000, 500, 30000);
      const page = await wikisourcePage({ title, signal: exec.signal });
      const fullLength = page.text.length;
      const body = fullLength > maxChars ? `${page.text.slice(0, maxChars)}\n\n……（以下截断，原文共 ${fullLength} 字符）` : page.text;
      return [
        `【典籍全文】${page.title}`,
        `来源：${page.url}`,
        `长度：${fullLength} 字符${fullLength > maxChars ? `，已截取前 ${maxChars}` : ''}`,
        `读取时间：${nowStamp()}`,
        '',
        '---',
        body,
      ].join('\n');
    },
  });

  registerTool({
    name: 'translate_classic',
    description:
      'Translate a classical Chinese passage into modern Chinese (default) or English, grounded in retrieved material: first searches Chinese Wikisource for the source/parallel passage, then asks the Classics Translator expert to translate with exegesis and notes. Returns the retrieved evidence, the translation, notes and open questions. The expert cannot see this conversation, so include enough context in `text` and `source`.',
    parameters: parameterSchema({
      text: {
        type: 'string',
        required: true,
        description: 'The classical passage to translate. Quote it exactly; do not paraphrase before translating.',
      },
      source: {
        type: 'string',
        description: 'Optional bibliographic source: book/chapter, e.g. "史记·项羽本纪" or "论语·学而".',
      },
      target: {
        type: 'string',
        description: 'Target language: "modern-chinese" (default) or "english".',
      },
    }),
    output: stringOutput(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const passage = trimmed(args?.text);
      if (passage === '') throw new Error('text 不能为空。');
      const sourceLabel = trimmed(args?.source);
      const targetInput = normalize(args?.target);
      const target = targetInput === 'english' || targetInput === 'en' ? 'english' : 'modern-chinese';

      const report = [];
      const evidence = [];
      const probe = passage.replace(/\s+/g, '').slice(0, 24);
      const searchExpression = [sourceLabel, probe].filter((part) => part !== '').join(' ');

      if (searchExpression !== '') {
        try {
          const hits = await wikisourceSearch({ query: searchExpression, limit: 3, signal: exec.signal });
          report.push({ source: '中文维基文库', ok: true });
          for (const hit of hits) {
            evidence.push(`- 维基文库《${hit.title}》：${hit.url}\n  摘要：${hit.snippet}`);
          }
        } catch (error) {
          report.push({ source: '中文维基文库', ok: false, detail: failureDetail(error) });
        }
      }

      if (evidence.length === 0) {
        try {
          const hits = await webSearch(ctx, {
            query: `${searchExpression} 原文 注释 翻译`,
            maxResults: 4,
            signal: exec.signal,
          });
          report.push({ source: '网页搜索', ok: true });
          for (const hit of hits) {
            evidence.push(`- 网页：${hit.title ?? '(无标题)'} ${hit.url}\n  摘要：${hit.snippet ?? ''}`);
          }
        } catch (error) {
          report.push({ source: '网页搜索', ok: false, detail: failureDetail(error) });
        }
      }

      const targetLine =
        target === 'english'
          ? '目标语言：英文（学术翻译体例，专名用拼音并附汉字）'
          : '目标语言：现代汉语（今译，不文白夹杂，专名首见加注）';
      const task = [
        '任务：翻译下面这段古籍原文。',
        targetLine,
        `出处：${sourceLabel === '' ? '用户未注明，请根据原文判断可能的出处并在输出中标注“出处待考”' : sourceLabel}`,
        '',
        '原文（逐字引用，不要改动）：',
        passage,
        '',
        evidence.length > 0
          ? ['检索到的参考材料（可能不完整或有误，需自行判断；引用时注明来源）：', ...evidence].join('\n')
          : '检索到的参考材料：无（维基文库与网页搜索均未获得可用材料）。请更谨慎地处理疑难字句，并在输出中说明缺少外部依据。',
        '',
        '输出要求：题解（1-2 句）→ 原文分段 → 译文 → 注释 → 存疑说明。',
        '每个疑难字词给出训释依据；有异文或歧解时在注释中交代，不要擅自择一而不说明。',
        '若参考材料与原文不一致，指出并说明采信理由。',
      ].join('\n');

      const expert = expertById('classics-translator');
      const answer = await runExpertChild(ctx, settings, expert, task, undefined, exec);

      return [
        `【古籍翻译】${target === 'english' ? '英译' : '今译'}${sourceLabel === '' ? '' : ` · ${sourceLabel}`}`,
        renderSourceReport(report),
        '',
        evidence.length > 0 ? '检索依据（供核对，不保证完整）：' : '检索依据：未获得外部材料，译文主要依据模型理解，请谨慎采用。',
        ...(evidence.length > 0 ? evidence : []),
        '',
        '===== 译文与注释 =====',
        answer,
        '',
        '提示：译文是学术辅助，引用前请核对底本与旧注；涉及关键论点时建议用 run_literature_panel 的翻译审校团复核。',
      ].join('\n');
    },
  });

  /* ---- 4. Citation verification ----------------------------------------- */

  registerTool({
    name: 'verify_citation',
    description:
      'Verify whether a cited work actually exists. With a DOI, checks Crossref for the exact record; without one, searches Crossref and OpenAlex by the citation text and scores title similarity. Returns a verdict (verified / partial match / not found), the matched metadata, and the minimal next step for manual verification. Use it before repeating any citation you cannot see a record for; a similar title is not evidence that the work exists.',
    parameters: parameterSchema({
      citation: {
        type: 'string',
        required: true,
        description:
          'Free-form citation or DOI, e.g. "余英时：《朱熹的历史世界》，北京：三联书店，2004年" or "10.1086/ahr/110.5.1423".',
      },
    }),
    output: stringOutput(),
    async execute(args, exec) {
      const citation = trimmed(args?.citation);
      if (citation === '') throw new Error('citation 不能为空。');
      const doi = extractDoi(citation);
      const report = [];
      const lines = [`【引用核验】${citation}`, `核验时间：${nowStamp()}`];

      if (doi !== undefined) {
        lines.push('', `识别到 DOI：${doi}`);
        try {
          const record = await crossrefDoi({ doi, signal: exec.signal });
          report.push({ source: 'Crossref DOI', ok: true });
          const claimedTitle = /[:：](.+?)[，,。.]/.exec(citation)?.[1];
          const similarity =
            claimedTitle === undefined ? 0 : titleSimilarity(claimedTitle, record.title);
          lines.push(
            renderSourceReport(report),
            '',
            `判定：已核实（DOI 在 Crossref 登记）`,
            '',
            formatPaper(1, record),
          );
          if (claimedTitle !== undefined && similarity < 0.5) {
            lines.push(
              '',
              `注意：引文中的题名与 DOI 记录题名相似度仅 ${(similarity * 100).toFixed(0)}%，可能张冠李戴；请核对是否引用了错误的 DOI。`,
            );
          }
          return lines.join('\n');
        } catch (error) {
          report.push({ source: 'Crossref DOI', ok: false, detail: failureDetail(error) });
          lines.push(
            renderSourceReport(report),
            '',
            '判定：未找到（DOI 未在 Crossref 登记）。不等于该文献不存在——可能是其他注册机构（DataCite 等）的 DOI，或 DOI 抄写有误。',
            '最小核实路径：到 doi.org 解析该 DOI；或到期刊官网按年卷期页核对。',
          );
          return lines.join('\n');
        }
      }

      const settled = await Promise.allSettled([
        searchCrossref({ query: citation, rows: 5, signal: exec.signal }),
        searchOpenAlex({ query: citation, perPage: 5, signal: exec.signal }),
      ]);
      const groups = [];
      settled.forEach((outcome, index) => {
        const label = index === 0 ? 'Crossref' : 'OpenAlex';
        if (outcome.status === 'fulfilled') {
          report.push({ source: label, ok: true });
          groups.push(outcome.value);
        } else {
          report.push({ source: label, ok: false, detail: failureDetail(outcome.reason) });
        }
      });
      const papers = mergePapers(groups);
      const scored = papers
        .map((paper) => ({
          paper,
          score: Math.max(
            titleSimilarity(citation, paper.title),
            citation.includes(paper.title) ? 0.8 : 0,
          ),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, 3);

      const best = scored[0];
      let verdict;
      if (best === undefined) {
        verdict = '未找到（Crossref 与 OpenAlex 均无匹配记录）。这不能证明文献伪造，但必须人工核实。';
      } else if (best.score >= 0.75) {
        verdict = `可能对应（最高相似度 ${(best.score * 100).toFixed(0)}%）。请比对作者、刊名、年卷期页后再判定为已核实。`;
      } else if (best.score >= 0.55) {
        verdict = `部分匹配（最高相似度 ${(best.score * 100).toFixed(0)}%）。题名接近但要素不符，存在张冠李戴或著录错误。`;
      } else {
        verdict = `未找到可靠匹配（最高相似度 ${(best.score * 100).toFixed(0)}%）。可能是中文文献未被 Crossref/OpenAlex 收录，也可能著录有误。`;
      }

      lines.push(renderSourceReport(report), '', `判定：${verdict}`);
      if (scored.length > 0) {
        lines.push('', '候选记录（相似度由高到低）：');
        scored.forEach((item, index) => {
          lines.push(
            formatPaper(index + 1, item.paper),
            `   与引文相似度：${(item.score * 100).toFixed(0)}%`,
          );
        });
      }
      lines.push(
        '',
        '最小核实路径：',
        '- 有 DOI/ISBN 时先解析 DOI（doi.org）或查 ISBN；',
        '- 中文论著可查中国国家图书馆 OPAC、读秀、CNKI 篇名库；',
        '- 外文论著可查 JSTOR、Project MUSE、出版社官网或 WorldCat；',
        '- 古籍核对书名、卷次、版本与馆藏，必要时用 search_classic_texts 查原文。',
      );
      return lines.join('\n');
    },
  });

  /* ---- 5. Standing guide ------------------------------------------------- *
   * Registered per Agent by `applyGate()` above, so switching the feature off
   * in one conversation removes the guide there and nowhere else.
   */
}
