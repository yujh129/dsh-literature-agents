/**
 * Data-source adapters for `dsh-literature-agents`.
 *
 * Three tiers, in the order the plugin prefers them:
 *   1. Structured scholarly metadata: Crossref, OpenAlex.
 *   2. Structured reference data: Wikidata (biography), Chinese Wikisource
 *      (primary texts).
 *   3. The host web-search service (`ctx.web.search`), used only as a fallback
 *      and always labelled as such.
 *
 * Design rules:
 * - Every adapter returns plain data; formatting lives in `index.js`.
 * - A failed source throws `SourceUnavailable`; callers degrade and report the
 *   failure instead of inventing results.
 * - Requests send a descriptive User-Agent (Wikimedia rejects default agents
 *   with HTTP 403) and are bounded by a timeout and the caller's signal.
 * - Short-lived in-memory cache keeps repeated tool calls from re-hitting the
 *   APIs (OpenAlex's keyless budget is shared per IP).
 */

/** Descriptive agent; Wikimedia APIs reject generic/default agents outright. */
const USER_AGENT =
  'dsh-literature-agents/1.0 (DeepSeek Harness literature plugin; classical-text research)';

const DEFAULT_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

/** @type {Map<string, { value: unknown, expires: number }>} */
const cache = new Map();

/** A source could not answer; callers must degrade, never fabricate. */
export class SourceUnavailable extends Error {
  /**
   * @param {string} source
   * @param {string} detail
   */
  constructor(source, detail) {
    super(`数据源「${source}」不可用：${detail}`);
    this.name = 'SourceUnavailable';
    this.source = source;
    this.detail = detail;
  }
}

/**
 * One-line reason for a failed fetch.
 * @param {unknown} error
 */
function describeNetworkError(error) {
  if (error instanceof Error && error.name === 'TimeoutError') return '连接超时';
  const cause = /** @type {{ cause?: { code?: string, message?: string } }} */ (error)?.cause;
  const code = cause?.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时（网络不可达）';
  if (code === 'ENOTFOUND') return '域名解析失败';
  if (code === 'CERT_HAS_EXPIRED') return 'TLS 证书失效';
  if (typeof code === 'string' && code !== '') return `网络错误 ${code}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch JSON with a timeout and the caller's cancellation signal.
 * @param {string} url
 * @param {{ signal?: AbortSignal, source?: string, timeoutMs?: number, accept?: string }} [options]
 * @returns {Promise<any>}
 */
export async function requestJson(url, options = {}) {
  const { signal, source = 'http', timeoutMs = DEFAULT_TIMEOUT_MS, accept = 'application/json' } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const retryable = new Set([403, 429, 500, 502, 503, 504]);
  const backoffMs = [0, 1200, 3500];
  let response;
  for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
    if (backoffMs[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
    }
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: accept,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        },
        signal: combined,
      });
    } catch (error) {
      throw new SourceUnavailable(source, describeNetworkError(error));
    }
    if (response.ok) break;
    if (!retryable.has(response.status) || attempt === backoffMs.length - 1) {
      // Wikimedia and OpenAlex throttle short bursts with 403/429; a short,
      // bounded backoff turns most of those into a working request, and the
      // remaining failure reports what the server actually said.
      const reason = await response
        .text()
        .then((body) =>
          stripHtml(
            String(body)
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<script[\s\S]*?<\/script>/gi, ' '),
          ).slice(0, 180),
        )
        .catch(() => '');
      throw new SourceUnavailable(
        source,
        reason === '' ? `HTTP ${response.status}` : `HTTP ${response.status}：${reason}`,
      );
    }
  }
  if (response === undefined || !response.ok) {
    throw new SourceUnavailable(source, '请求失败');
  }
  try {
    return await response.json();
  } catch {
    throw new SourceUnavailable(source, '返回内容不是有效 JSON');
  }
}

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} load
 * @returns {Promise<T>}
 */
async function cached(key, load) {
  const hit = cache.get(key);
  if (hit !== undefined && hit.expires > Date.now()) return /** @type {T} */ (hit.value);
  if (hit !== undefined) cache.delete(key);
  const value = await load();
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Strip the `<span class="searchmatch">` markup mediawiki search returns. */
export function stripHtml(input) {
  return String(input ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number(digits)))
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Paper metadata: Crossref + OpenAlex                                        */
/* -------------------------------------------------------------------------- */

/** Polite-pool contact for Crossref; placeholder is acceptable and honest. */
const CROSSREF_MAILTO = 'literature-agents@example.com';

/**
 * @typedef {{
 *   title: string,
 *   authors: string[],
 *   year?: number,
 *   venue?: string,
 *   publisher?: string,
 *   type?: string,
 *   doi?: string,
 *   url?: string,
 *   source: string,
 * }} Paper
 */

/**
 * @param {any} item
 * @returns {Paper}
 */
function crossrefToPaper(item) {
  const title = Array.isArray(item.title) ? item.title[0] : item.title;
  const year = item.issued?.['date-parts']?.[0]?.[0];
  const venue = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'];
  return {
    title: String(title ?? '').replace(/<[^>]+>/g, '').trim(),
    authors: (Array.isArray(item.author) ? item.author : [])
      .map((author) => [author.given, author.family].filter(Boolean).join(' ').trim())
      .filter((name) => name !== ''),
    year: Number.isFinite(year) ? Number(year) : undefined,
    venue: typeof venue === 'string' ? venue.trim() : undefined,
    publisher: typeof item.publisher === 'string' ? item.publisher.trim() : undefined,
    type: typeof item.type === 'string' ? item.type : undefined,
    doi: typeof item.DOI === 'string' ? item.DOI : undefined,
    url:
      typeof item.URL === 'string' && item.URL !== ''
        ? item.URL
        : typeof item.DOI === 'string'
          ? `https://doi.org/${item.DOI}`
          : undefined,
    source: 'crossref',
  };
}

/**
 * Search Crossref works.
 * @param {{ query?: string, author?: string, yearFrom?: number, yearTo?: number, rows?: number, signal?: AbortSignal }} options
 * @returns {Promise<Paper[]>}
 */
export async function searchCrossref(options = {}) {
  const { query, author, yearFrom, yearTo, rows = 10, signal } = options;
  const params = new URLSearchParams();
  if (query !== undefined && query !== '') params.set('query.bibliographic', query);
  if (author !== undefined && author !== '') params.set('query.author', author);
  params.set('rows', String(Math.max(1, Math.min(50, rows))));
  params.set('select', 'DOI,title,author,issued,container-title,publisher,type,URL');
  params.set('mailto', CROSSREF_MAILTO);
  const filters = [];
  if (Number.isFinite(yearFrom)) filters.push(`from-pub-date:${yearFrom}-01-01`);
  if (Number.isFinite(yearTo)) filters.push(`until-pub-date:${yearTo}-12-31`);
  if (filters.length > 0) params.set('filter', filters.join(','));

  const url = `https://api.crossref.org/works?${params.toString()}`;
  const data = await cached(`crossref:${url}`, () =>
    requestJson(url, { source: 'crossref', signal }),
  );
  const items = Array.isArray(data?.message?.items) ? data.message.items : [];
  return items.map(crossrefToPaper).filter((paper) => paper.title !== '');
}

/**
 * @param {any} work
 * @returns {Paper}
 */
function openAlexToPaper(work) {
  const authors = (Array.isArray(work.authorships) ? work.authorships : [])
    .map((authorship) => authorship?.author?.display_name)
    .filter((name) => typeof name === 'string' && name !== '');
  const doiRaw = typeof work.doi === 'string' ? work.doi.replace(/^https?:\/\/doi\.org\//, '') : undefined;
  return {
    title: String(work.display_name ?? work.title ?? '').trim(),
    authors,
    year: Number.isFinite(work.publication_year) ? Number(work.publication_year) : undefined,
    venue: work.primary_location?.source?.display_name ?? undefined,
    publisher: work.primary_location?.source?.host_organization_name ?? undefined,
    type: typeof work.type === 'string' ? work.type : undefined,
    doi: doiRaw,
    url: typeof work.id === 'string' ? work.id : doiRaw === undefined ? undefined : `https://doi.org/${doiRaw}`,
    source: 'openalex',
  };
}

/**
 * Search OpenAlex works.
 * @param {{ query: string, perPage?: number, signal?: AbortSignal }} options
 * @returns {Promise<Paper[]>}
 */
export async function searchOpenAlex(options) {
  const { query, perPage = 10, signal } = options;
  const params = new URLSearchParams({
    search: query,
    'per-page': String(Math.max(1, Math.min(50, perPage))),
  });
  const url = `https://api.openalex.org/works?${params.toString()}`;
  const data = await cached(`openalex:${url}`, () =>
    requestJson(url, { source: 'openalex', signal }),
  );
  const works = Array.isArray(data?.results) ? data.results : [];
  return works.map(openAlexToPaper).filter((paper) => paper.title !== '');
}

/**
 * Find an OpenAlex author and that author's most-cited works.
 * @param {{ name: string, limit?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ author?: { id: string, name: string, worksCount?: number }, works: Paper[], candidates: Array<{ id: string, name: string, worksCount?: number }> }>}
 */
export async function findOpenAlexAuthorWorks(options) {
  const { name, limit = 10, signal } = options;
  const searchUrl = `https://api.openalex.org/authors?search=${encodeURIComponent(name)}&per-page=5`;
  const search = await cached(`openalex-authors:${name}`, () =>
    requestJson(searchUrl, { source: 'openalex', signal }),
  );
  const candidates = (Array.isArray(search?.results) ? search.results : []).map((author) => ({
    id: String(author.id ?? '').replace('https://openalex.org/', ''),
    name: String(author.display_name ?? ''),
    worksCount: Number.isFinite(author.works_count) ? Number(author.works_count) : undefined,
  }));
  const best = candidates[0];
  if (best === undefined || best.id === '') return { works: [], candidates };
  const worksUrl = `https://api.openalex.org/works?filter=author.id:${encodeURIComponent(best.id)}&per-page=${Math.max(1, Math.min(25, limit))}&sort=cited_by_count:desc`;
  const worksData = await cached(`openalex-author-works:${best.id}:${limit}`, () =>
    requestJson(worksUrl, { source: 'openalex', signal }),
  );
  const works = (Array.isArray(worksData?.results) ? worksData.results : [])
    .map(openAlexToPaper)
    .filter((paper) => paper.title !== '');
  return { author: best, works, candidates };
}

/** Normalize a title for dedupe/compare: lowercase, keep letters and CJK. */
export function normalizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Merge paper groups, dedupe by DOI then normalized title, and prefer records
 * that carry more bibliographic fields.
 * @param {Paper[][]} groups
 * @returns {Paper[]}
 */
export function mergePapers(groups) {
  /** @type {Map<string, Paper>} */
  const byKey = new Map();
  for (const group of groups) {
    for (const paper of group) {
      const key =
        paper.doi !== undefined && paper.doi !== ''
          ? `doi:${paper.doi.toLowerCase()}`
          : `title:${normalizeTitle(paper.title)}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, paper);
        continue;
      }
      const merged = {
        ...existing,
        authors: existing.authors.length >= paper.authors.length ? existing.authors : paper.authors,
        year: existing.year ?? paper.year,
        venue: existing.venue ?? paper.venue,
        publisher: existing.publisher ?? paper.publisher,
        type: existing.type ?? paper.type,
        doi: existing.doi ?? paper.doi,
        url: existing.url ?? paper.url,
        source:
          existing.source === paper.source ? existing.source : `${existing.source}+${paper.source}`,
      };
      byKey.set(key, merged);
    }
  }
  const papers = [...byKey.values()];
  papers.sort((left, right) => (right.year ?? 0) - (left.year ?? 0));
  return papers;
}

/* -------------------------------------------------------------------------- */
/* Biography: Wikidata                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ id: string, label: string, description?: string }} WikidataCandidate
 */

/**
 * Entity search restricted to items.
 * @param {{ name: string, limit?: number, language?: string, signal?: AbortSignal }} options
 * @returns {Promise<WikidataCandidate[]>}
 */
export async function wikidataSearch(options) {
  const { name, limit = 5, language = 'zh', signal } = options;
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language,
    uselang: language,
    format: 'json',
    limit: String(limit),
    type: 'item',
  });
  const url = `https://www.wikidata.org/w/api.php?${params.toString()}`;
  const data = await cached(`wikidata-search:${language}:${name}:${limit}`, () =>
    requestJson(url, { source: 'wikidata', signal }),
  );
  const hits = Array.isArray(data?.search) ? data.search : [];
  return hits.map((hit) => ({
    id: String(hit.id ?? ''),
    label: String(hit.label ?? hit.id ?? ''),
    description: typeof hit.description === 'string' ? hit.description : undefined,
  }));
}

/**
 * Fetch one entity.
 * @param {{ qid: string, signal?: AbortSignal }} options
 */
export async function wikidataEntity(options) {
  const { qid, signal } = options;
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const data = await cached(`wikidata-entity:${qid}`, () =>
    requestJson(url, { source: 'wikidata', signal, timeoutMs: 20000 }),
  );
  const entity = data?.entities?.[qid];
  if (entity === undefined || entity === null) {
    throw new SourceUnavailable('wikidata', `未找到实体 ${qid}`);
  }
  return entity;
}

/**
 * Resolve Chinese/English labels for referenced item ids.
 * @param {{ qids: string[], signal?: AbortSignal }} options
 * @returns {Promise<Map<string, string>>}
 */
export async function wikidataLabels(options) {
  const { qids, signal } = options;
  const unique = [...new Set(qids.filter((qid) => /^Q\d+$/.test(qid)))];
  /** @type {Map<string, string>} */
  const labels = new Map();
  if (unique.length === 0) return labels;
  for (let start = 0; start < unique.length; start += 45) {
    const batch = unique.slice(start, start + 45);
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'labels',
      languages: 'zh|zh-hans|zh-hant|en',
      format: 'json',
    });
    const url = `https://www.wikidata.org/w/api.php?${params.toString()}`;
    const data = await cached(`wikidata-labels:${batch.join('|')}`, () =>
      requestJson(url, { source: 'wikidata', signal }),
    );
    for (const qid of batch) {
      const labelSet = data?.entities?.[qid]?.labels ?? {};
      const label =
        labelSet.zh?.value ?? labelSet['zh-hans']?.value ?? labelSet['zh-hant']?.value ?? labelSet.en?.value;
      if (typeof label === 'string' && label !== '') labels.set(qid, label);
    }
  }
  return labels;
}

/** Read the first snak value of a claim. @param {any} entity @param {string} property */
function firstClaim(entity, property) {
  const claim = entity?.claims?.[property]?.[0];
  return claim?.mainsnak?.datavalue?.value;
}

/** All item ids of a claim. @param {any} entity @param {string} property */
function claimItemIds(entity, property) {
  const claims = Array.isArray(entity?.claims?.[property]) ? entity.claims[property] : [];
  return claims
    .map((claim) => claim?.mainsnak?.datavalue?.value?.id)
    .filter((id) => typeof id === 'string' && /^Q\d+$/.test(id));
}

/** All time values of a claim. @param {any} entity @param {string} property */
function claimTimes(entity, property) {
  const claims = Array.isArray(entity?.claims?.[property]) ? entity.claims[property] : [];
  return claims
    .map((claim) => claim?.mainsnak?.datavalue?.value)
    .filter((value) => typeof value?.time === 'string');
}

/**
 * Wikidata stores BCE years directly with a minus sign: `-0145` is 145 BCE.
 * Precision 9 = year, 10 = month, 11 = day.
 * @param {{ time: string, precision?: number } | undefined} value
 */
export function formatWikidataTime(value) {
  if (value === undefined) return '';
  const match = /^([+-])(\d+)-(\d{2})-(\d{2})T/.exec(value.time);
  if (match === null) return value.time;
  const sign = match[1] === '-' ? '公元前' : '';
  const year = Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const precision = value.precision ?? 9;
  if (precision >= 11 && month > 0 && day > 0) return `${sign}${year}年${month}月${day}日`;
  if (precision >= 10 && month > 0) return `${sign}${year}年${month}月`;
  return `${sign}${year}年`;
}

/**
 * @typedef {{
 *   qid: string,
 *   label: string,
 *   description?: string,
 *   aliases: string[],
 *   nativeName?: string,
 *   birth?: string,
 *   death?: string,
 *   birthPlace?: string,
 *   deathPlace?: string,
 *   occupations: string[],
 *   fields: string[],
 *   education: string[],
 *   employers: string[],
 *   awards: string[],
 *   notableWorks: string[],
 *   wikidataUrl: string,
 *   wikipediaUrl?: string,
 *   wikisourceUrl?: string,
 * }} PersonSummary
 */

/**
 * Turn one entity into a person summary, resolving referenced labels.
 * @param {{ entity: any, signal?: AbortSignal }} options
 * @returns {Promise<PersonSummary>}
 */
export async function summarizePerson(options) {
  const { entity, signal } = options;
  const label = entity?.labels?.zh?.value ?? entity?.labels?.['zh-hans']?.value ?? entity?.labels?.en?.value ?? entity.id;
  const description =
    entity?.descriptions?.zh?.value ??
    entity?.descriptions?.['zh-hans']?.value ??
    entity?.descriptions?.en?.value;
  const aliases = Array.isArray(entity?.aliases?.zh)
    ? entity.aliases.zh.map((alias) => alias.value).filter(Boolean)
    : [];

  const referenced = [
    ...claimItemIds(entity, 'P19'),
    ...claimItemIds(entity, 'P20'),
    ...claimItemIds(entity, 'P106'),
    ...claimItemIds(entity, 'P101'),
    ...claimItemIds(entity, 'P69'),
    ...claimItemIds(entity, 'P108'),
    ...claimItemIds(entity, 'P166'),
    ...claimItemIds(entity, 'P800'),
  ];
  const labels = await wikidataLabels({ qids: referenced, signal });
  /** @param {string} property */
  const names = (property) =>
    claimItemIds(entity, property)
      .map((qid) => labels.get(qid))
      .filter((name) => typeof name === 'string' && name !== '');

  const nativeNameValue = firstClaim(entity, 'P1559');
  const sitelinks = entity?.sitelinks ?? {};
  const wikiTitle = sitelinks.zhwiki?.title;
  const sourceTitle = sitelinks.zhwikisource?.title;

  return {
    qid: String(entity.id),
    label: String(label ?? entity.id),
    description: typeof description === 'string' ? description : undefined,
    aliases: aliases.slice(0, 8),
    nativeName:
      typeof nativeNameValue?.text === 'string'
        ? nativeNameValue.text
        : typeof nativeNameValue?.value === 'string'
          ? nativeNameValue.value
          : undefined,
    birth: formatWikidataTime(claimTimes(entity, 'P569')[0]) || undefined,
    death: formatWikidataTime(claimTimes(entity, 'P570')[0]) || undefined,
    birthPlace: names('P19')[0],
    deathPlace: names('P20')[0],
    occupations: names('P106'),
    fields: names('P101'),
    education: names('P69'),
    employers: names('P108'),
    awards: names('P166'),
    notableWorks: names('P800'),
    wikidataUrl: `https://www.wikidata.org/wiki/${encodeURIComponent(String(entity.id))}`,
    wikipediaUrl:
      typeof wikiTitle === 'string'
        ? `https://zh.wikipedia.org/wiki/${encodeURIComponent(wikiTitle.replace(/ /g, '_')).replace(/%2F/g, '/')}`
        : undefined,
    wikisourceUrl:
      typeof sourceTitle === 'string'
        ? `https://zh.wikisource.org/wiki/${encodeURIComponent(sourceTitle.replace(/ /g, '_')).replace(/%2F/g, '/')}`
        : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Primary texts: Chinese Wikisource                                          */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ title: string, snippet: string, url: string }} ClassicHit
 */

/** Build a Wikisource article URL that keeps subpage slashes literal. */
function wikisourceUrl(title) {
  return `https://zh.wikisource.org/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`;
}

/**
 * Full-text search over the Chinese Wikisource main namespace.
 * @param {{ query: string, limit?: number, signal?: AbortSignal }} options
 * @returns {Promise<ClassicHit[]>}
 */
export async function wikisourceSearch(options) {
  const { query, limit = 8, signal } = options;
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(Math.max(1, Math.min(20, limit))),
    srnamespace: '0',
    srprop: 'snippet',
    format: 'json',
  });
  const url = `https://zh.wikisource.org/w/api.php?${params.toString()}`;
  const data = await cached(`wikisource-search:${query}:${limit}`, () =>
    requestJson(url, { source: 'wikisource', signal }),
  );
  const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
  return hits.map((hit) => ({
    title: String(hit.title ?? ''),
    snippet: stripHtml(hit.snippet),
    url: wikisourceUrl(String(hit.title ?? '')),
  }));
}

/**
 * Fetch one Wikisource page's wikitext and a plain-text rendering.
 * @param {{ title: string, signal?: AbortSignal }} options
 * @returns {Promise<{ title: string, url: string, text: string }>}
 */
export async function wikisourcePage(options) {
  const { title, signal } = options;
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    format: 'json',
    formatversion: '2',
    redirects: '1',
  });
  const url = `https://zh.wikisource.org/w/api.php?${params.toString()}`;
  const data = await cached(`wikisource-page:${title}`, () =>
    requestJson(url, { source: 'wikisource', signal, timeoutMs: 20000 }),
  );
  if (typeof data?.error?.info === 'string') {
    throw new SourceUnavailable('wikisource', data.error.info);
  }
  const wikitext = data?.parse?.wikitext;
  if (typeof wikitext !== 'string' || wikitext.trim() === '') {
    throw new SourceUnavailable('wikisource', `页面「${title}」没有可读取的正文`);
  }
  const resolvedTitle = String(data.parse.title ?? title);
  return {
    title: resolvedTitle,
    url: wikisourceUrl(resolvedTitle),
    text: stripWikitext(wikitext),
  };
}

/** Remove balanced `{{...}}` templates, including nested ones. */
function stripTemplates(input) {
  let output = '';
  let depth = 0;
  let index = 0;
  while (index < input.length) {
    if (input.startsWith('{{', index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (input.startsWith('}}', index)) {
      if (depth > 0) depth -= 1;
      index += 2;
      continue;
    }
    if (depth === 0) output += input[index];
    index += 1;
  }
  return output;
}

/**
 * Render MediaWiki wikitext as readable plain text.
 * @param {string} input
 */
export function stripWikitext(input) {
  let text = String(input ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/__[A-Z][A-Z_]*__/g, '');
  text = text.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  text = stripTemplates(text);
  text = text.replace(/\{\|[\s\S]*?\|\}/g, '');
  text = text.replace(/\[\[(?:File|Image|文件|圖像|图像|Category|分類|分类):[^\]]*\]\]/gi, '');
  text = text.replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');
  text = text.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1');
  text = text.replace(/\[https?:\/\/\S+\]/g, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/^=+\s*(.*?)\s*=+$/gm, '$1');
  text = text.replace(/'{2,}/g, '');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number(digits)));
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/* -------------------------------------------------------------------------- */
/* Last resort: host web search                                               */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ title?: string, url: string, snippet?: string, publishedAt?: string }} WebHit
 */

/**
 * Query the host web-search service. Callers treat the result as a lead, not
 * as authority.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ query: string, maxResults?: number, signal?: AbortSignal }} options
 * @returns {Promise<WebHit[]>}
 */
export async function webSearch(ctx, options) {
  const { query, maxResults = 6, signal } = options;
  const web = ctx === undefined || ctx === null ? undefined : ctx.get('web');
  if (web === undefined || web === null) {
    throw new SourceUnavailable('web', '宿主未注册搜索服务（需要 dsh-free-search 或同类 provider）');
  }
  let result;
  try {
    result = await web.search({ query, maxResults }, signal);
  } catch (error) {
    throw new SourceUnavailable('web', describeNetworkError(error));
  }
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  return sources.map((source) => ({
    title: typeof source.title === 'string' ? source.title : undefined,
    url: String(source.url ?? ''),
    snippet: typeof source.snippet === 'string' ? stripHtml(source.snippet) : undefined,
    publishedAt: typeof source.publishedAt === 'string' ? source.publishedAt : undefined,
  }));
}

/* -------------------------------------------------------------------------- */
/* Citation verification                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Extract a DOI from free text.
 * @param {string} input
 */
export function extractDoi(input) {
  const match = /10\.\d{4,9}\/[-._;()/:a-zA-Z0-9]+/.exec(String(input ?? ''));
  if (match === null) return undefined;
  return match[0].replace(/[.,;]+$/, '');
}

/**
 * Fetch one Crossref record by DOI.
 * @param {{ doi: string, signal?: AbortSignal }} options
 * @returns {Promise<Paper>}
 */
export async function crossrefDoi(options) {
  const { doi, signal } = options;
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(CROSSREF_MAILTO)}`;
  const data = await cached(`crossref-doi:${doi.toLowerCase()}`, () =>
    requestJson(url, { source: 'crossref', signal }),
  );
  const item = data?.message;
  if (item === undefined || item === null) {
    throw new SourceUnavailable('crossref', `未找到 DOI ${doi}`);
  }
  return crossrefToPaper(item);
}

/**
 * Traditional → simplified pairs for the characters that actually show up in
 * Chinese scholarly titles and personal names. This is deliberately a small
 * fold used only for title comparison, not a full OpenCC conversion: its job is
 * to stop 史記/史记 from scoring as unrelated.
 */
const T2S_PAIRS = `
國国 學学 會会 歷历 曆历 記记 紀纪 書书 傳传 論论 說说 語语 詩诗 詞词 經经 義义 體体 變变 遷迁
漢汉 後后 時时 間间 開开 關关 長长 門门 問问 題题 東东 車车 馬马 鳥鸟 魚鱼 龍龙 鳳凤 雲云 電电
氣气 風风 歲岁 萬万 與与 為为 這这 個个 們们 來来 進进 過过 還还 邊边 對对 應应 當当 實实 際际
產产 農农 業业 醫医 藥药 術术 藝艺 樂乐 畫画 圖图 館馆 檔档 資资 訊讯 網网 線线 機机 構构 權权
責责 證证 據据 結结 點点 標标 準准 確确 認认 討讨 檢检 測测 驗验 讀读 寫写 譯译 註注 釋释 補补
遺遗 輯辑 評评 錢钱 顧顾 頡颉 剛刚 啟启 維维 陳陈 劉刘 楊杨 黃黄 趙赵 吳吴 鄭郑 孫孙 張张 馮冯
陸陆 蘇苏 蔣蒋 葉叶 呂吕 喬乔 歐欧 盧卢 嚴严 龔龚 賈贾 費费 項项 韓韩 魯鲁 齊齐 晉晋 衛卫 單单
竇窦 慶庆 鐘钟 鍾钟 閒闲 閑闲 橫横 縱纵 繪绘 聲声 韻韵 辭辞 賦赋 騷骚 緯纬 譜谱 敘叙 雜杂 誌志
叢丛 編编 纂纂 鈔钞 臺台 彙汇 範范 鑑鉴 鑒鉴 辯辩 鬥斗 麗丽 屬属 復复 複复 嶽岳 灣湾 遼辽 寧宁
陝陕 廬庐 滬沪 濱滨 閩闽 粵粤 贛赣 潁颍 舊旧 歸归 斷断 續续 繼继 統统 綱纲 約约 純纯 紙纸 級级
給给 綜综 綠绿 價价 億亿 儀仪 優优 兒儿 內内 兩两 冊册 軍军 戰战 擊击 敗败 數数 敵敌 綱纲 書书
`
  .trim()
  .split(/\s+/)
  .filter((pair) => pair.length === 2 && pair[0] !== pair[1]);

/** @type {Map<string, string>} */
const T2S = new Map(T2S_PAIRS.map((pair) => [pair[0], pair[1]]));

/**
 * Fold traditional forms to simplified where the pair is known. Unknown
 * characters are returned unchanged.
 * @param {string} text
 */
export function foldScript(text) {
  let output = '';
  for (const character of String(text ?? '')) {
    output += T2S.get(character) ?? character;
  }
  return output;
}

/**
 * Character-bigram + word Jaccard similarity for mixed CJK/Latin titles.
 * Han text is script-folded first so 史記/史记 compare as the same title.
 * @param {string} left
 * @param {string} right
 */
export function titleSimilarity(left, right) {
  /**
   * @param {string} value
   * @returns {Set<string>}
   */
  const tokens = (value) => {
    const text = foldScript(String(value ?? '').toLowerCase());
    const set = new Set();
    const latinWords = text.match(/[a-z0-9]{2,}/g) ?? [];
    for (const word of latinWords) set.add(`w:${word}`);
    const cjk = text.replace(/[^\p{Script=Han}]/gu, '');
    for (let index = 0; index + 1 < cjk.length; index += 1) {
      set.add(`b:${cjk.slice(index, index + 2)}`);
    }
    return set;
  };
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const jaccard = intersection / (a.size + b.size - intersection);
  // A short citation title contained in a longer database title should count as
  // a match; plain Jaccard would dilute it with the longer title's extra words.
  const coverage = intersection / Math.min(a.size, b.size);
  const contained = Math.min(a.size, b.size) >= 2 ? coverage * 0.95 : 0;
  return Math.max(jaccard, contained);
}
