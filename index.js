/**
 * GitHub open-source radar for DeepSeek Harness.
 *
 * Installs two things into every agent of this profile:
 *  1. a system-prompt policy that makes the model extract keywords from each new
 *     request and look for reusable open-source projects on GitHub before it
 *     answers, and
 *  2. a Host tool, `github_search`, that performs the actual GitHub Search API
 *     lookup and returns a compact, model-readable list of repositories.
 *
 * The search is deliberately budgeted: one call per request, a ten-minute
 * in-memory cache, and coalescing of identical in-flight requests keep the
 * unauthenticated Search API limit (10 requests per minute) out of the way.
 * The plugin has no runtime dependencies; it uses the global `fetch` of the
 * Host process and registers raw tool definitions, so a linked local bundle
 * resolves without a workspace `node_modules`.
 */

/** Fallback settings when the loader row carries no (or partial) config. */
const DEFAULT_CONFIG = {
  enabled: true,
  maxResults: 5,
  minStars: 0,
  language: '',
  includeArchived: false,
  cacheTtlMs: 600000,
  timeoutMs: 15000,
  tokenEnv: 'GITHUB_TOKEN',
  token: '',
};

/** Placement of the policy section: immediately before the built-in web-search guidance (2000). */
const SECTION_ORDER = 1990;
const SECTION_NAME = 'github-oss-radar:policy';

const TOOL_NAME = 'github_search';
const API_URL = 'https://api.github.com/search/repositories';
const API_VERSION = '2022-11-28';
const MAX_KEYWORDS = 4;
const MAX_LIMIT = 10;
const MAX_CACHE_ENTRIES = 64;

/** Supported sort orders: `best-match` is the API's own relevance order. */
const SORT_ORDERS = ['stars', 'updated', 'best-match'];

export const inject = ['tools', 'systemPrompt'];

/**
 * Register the prompt policy and the search tool for every agent in the profile.
 * @param ctx Plugin context.
 * @param config Loader row config (`config:` in the bundle patch).
 */
export function apply(ctx, config = {}) {
  const settings = readConfig(config);
  if (!settings.enabled) return;

  const cache = createCache(settings.cacheTtlMs);
  const inflight = new Map();

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: policyText(settings),
  }));

  ctx.effect(() => ctx.tools.register(toolDefinition(settings, cache, inflight)));
}

/* ------------------------------------------------------------------ policy */

/**
 * Build the standing instruction that makes GitHub-first search part of every turn.
 * @param settings Resolved plugin settings.
 * @returns Prompt section text.
 */
function policyText(settings) {
  const limit = settings.maxResults;
  return [
    '## GitHub open-source radar',
    '',
    'Every new user request starts with a quick open-source check, before any other work:',
    '',
    `1. Extract 1–${MAX_KEYWORDS} English keywords that name the request's technology, domain, or task. Keep product names verbatim; translate other terms to English instead of searching in Chinese.`,
    `2. Call \`${TOOL_NAME}\` at most once per request with those keywords. Pass \`language\` only when the request clearly names a programming language, keep the requested count at or below ${limit}, and do not repeat the call for a follow-up on the same subject.`,
    `3. Before answering, list up to ${limit} genuinely relevant repositories: \`owner/repo\` (★ count) — one line on what it does and why it fits, plus its GitHub URL. Put the list under a short heading (in a Chinese answer: 「可能相关的开源项目」). One short list only; never dump every result.`,
    '4. If nothing is genuinely relevant, say so in one line and continue normally. The search must not delay the real answer, and it never replaces reading the user\'s own files.',
    '5. GitHub is the first place to look for reusable code: use this search before a general web search whenever an existing project could solve the request.',
    '6. If the tool fails or reports a rate limit, do not retry; continue without the list and mention the failure in one line at most.',
    '7. For follow-up messages inside an already understood task, repeat the search only when the subject changes.',
    '',
    'The search is a tool call, not a substitute for the answer: the user wants working results, not a link dump.',
  ].join('\n');
}

/* -------------------------------------------------------------------- tool */

/**
 * Build the raw, registry-ready tool definition.
 * @param settings Resolved plugin settings.
 * @param cache Search cache for this plugin instance.
 * @param inflight Map of identical in-flight searches, keyed by query.
 * @returns Tool definition consumed by `ctx.tools.register`.
 */
function toolDefinition(settings, cache, inflight) {
  return {
    name: TOOL_NAME,
    description: [
      'Search GitHub repositories for existing open-source projects that match keywords.',
      'Use it at the start of a request when the task may already have a reusable library, framework, tool, template, or dataset.',
      'Returns the top repositories sorted by stars (or by last update, or by relevance) with repository name, URL, one-line description, star and fork counts, language, license, topics, and last push date.',
      'Call it at most once per request; repeated identical searches inside the cache window return the cached list instead of spending another API request.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: `1–${MAX_KEYWORDS} English technical keywords naming the technology, domain, or task. Searched with AND semantics.`,
        },
        query: {
          type: 'string',
          description: 'Optional exact GitHub repository search query; when present it overrides keywords.',
        },
        language: {
          type: 'string',
          description: 'Optional GitHub language filter, for example Python or TypeScript.',
        },
        min_stars: {
          type: 'integer',
          description: 'Optional minimum star count. Defaults to the plugin setting.',
        },
        limit: {
          type: 'integer',
          description: `Optional number of repositories to return, 1–${MAX_LIMIT}. Defaults to the plugin setting.`,
        },
        sort: {
          type: 'string',
          enum: SORT_ORDERS,
          description: 'Optional ordering: `stars` (default), `updated` for recently pushed projects, or `best-match` for GitHub relevance.',
        },
      },
      required: ['keywords'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const request = normalizeArgs(args, settings);
      return searchGitHub(request, exec.signal, settings, cache, inflight);
    },
  };
}

/* --------------------------------------------------------------- arguments */

/**
 * Validate and normalize model-supplied arguments into one search request.
 * @param args Raw tool arguments.
 * @param settings Resolved plugin settings.
 * @returns Normalized request.
 */
export function normalizeArgs(args, settings) {
  if (!isPlainObject(args)) throw new Error(`${TOOL_NAME} expects an object argument`);

  const keywords = [];
  if (Array.isArray(args.keywords)) {
    for (const entry of args.keywords) {
      if (typeof entry !== 'string') continue;
      const keyword = entry.trim();
      if (keyword.length > 0) keywords.push(keyword);
    }
  }
  if (keywords.length > MAX_KEYWORDS) throw new Error(`keywords accepts at most ${MAX_KEYWORDS} entries`);

  const query = typeof args.query === 'string' && args.query.trim().length > 0 ? args.query.trim() : '';
  if (query.length === 0 && keywords.length === 0) {
    throw new Error(`keywords is required: pass an array of 1–${MAX_KEYWORDS} English keywords (or an exact \`query\`)`);
  }

  const language = sanitizeLanguage(args.language ?? settings.language);
  const minStars = clampInteger(args.min_stars, settings.minStars, 0, 1000000);
  const limit = clampInteger(args.limit, settings.maxResults, 1, MAX_LIMIT);
  const sort = sanitizeSort(args.sort);

  return { keywords, query, language, minStars, limit, sort };
}

/** Normalize an optional GitHub language filter. */
function sanitizeLanguage(value) {
  if (typeof value !== 'string') return '';
  const language = value.trim();
  if (language.length === 0) return '';
  if (language.length > 30 || /["\\\r\n]/.test(language)) return '';
  return language;
}

/** Normalize an optional sort order, falling back to `stars`. */
function sanitizeSort(value) {
  if (typeof value !== 'string') return 'stars';
  const sort = value.trim().toLowerCase();
  return SORT_ORDERS.includes(sort) ? sort : 'stars';
}

/** Clamp one optional integer argument into range, falling back to a default. */
function clampInteger(value, fallback, min, max) {
  const candidate = Number(value);
  const base = Number.isFinite(candidate) && Number.isInteger(candidate) ? candidate : fallback;
  return Math.min(max, Math.max(min, base));
}

/* ------------------------------------------------------------------ search */

/**
 * Query the GitHub Search API once (with one broadening retry) and format the matches.
 * @param request Normalized request.
 * @param outerSignal Tool execution cancellation signal.
 * @param settings Resolved plugin settings.
 * @param cache Search cache for this plugin instance.
 * @param inflight Map of identical in-flight searches.
 * @returns Model-readable result text.
 */
async function searchGitHub(request, outerSignal, settings, cache, inflight) {
  const query = composeQuery(request.keywords, request.query, request.language, request.minStars, settings.includeArchived);
  const key = cacheKey(query, request.limit, request.sort);

  const cached = cache.get(key);
  if (cached !== null) return cached;

  const pending = inflight.get(key);
  if (pending !== undefined) return pending;

  const promise = (async () => {
    try {
      const text = await runSearch(request, outerSignal, settings);
      cache.set(key, text);
      return text;
    } catch (error) {
      const stale = cache.getStale(key);
      if (stale !== null) return `${stale}\n\n(Note: ${messageOf(error)} Showing the cached result from earlier.)`;
      throw error;
    }
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Perform the network search and render the result.
 *
 * The broadened retry is deliberately not re-read from the cache: it happens at
 * most once per primary query and the primary query already owns the cache
 * entry, so a second lookup would only add a way for the two to disagree.
 *
 * @param request Normalized request.
 * @param outerSignal Tool execution cancellation signal.
 * @param settings Resolved plugin settings.
 * @returns Model-readable result text.
 */
async function runSearch(request, outerSignal, settings) {
  let keywords = request.keywords;
  let query = composeQuery(keywords, request.query, request.language, request.minStars, settings.includeArchived);
  let result = await requestRepositories(query, request.limit, request.sort, outerSignal, settings);

  let broadened = false;
  if (result.totalCount === 0 && request.query.length === 0 && keywords.length > 1) {
    keywords = keywords.slice(0, 1);
    broadened = true;
    query = composeQuery(keywords, request.query, request.language, request.minStars, settings.includeArchived);
    result = await requestRepositories(query, request.limit, request.sort, outerSignal, settings);
  }

  return formatMatches(result, {
    keywords,
    query,
    limit: request.limit,
    minStars: request.minStars,
    sort: request.sort,
    broadened,
  });
}

/**
 * Compose the GitHub repository search query string.
 * @param keywords Extracted keywords (AND semantics).
 * @param exactQuery Optional exact query that overrides keywords.
 * @param language Optional language qualifier.
 * @param minStars Minimum star count qualifier.
 * @param includeArchived Whether archived repositories are allowed.
 * @returns Query string.
 */
export function composeQuery(keywords, exactQuery, language, minStars, includeArchived) {
  const parts = [];
  if (exactQuery.length > 0) parts.push(exactQuery);
  else parts.push(keywords.join(' '));
  if (minStars > 0) parts.push(`stars:>=${minStars}`);
  if (language.length > 0) parts.push(`language:${language}`);
  if (!includeArchived) parts.push('archived:false');
  return parts.join(' ').trim();
}

/**
 * Build the cache key of one search.
 * @param query Repository search query.
 * @param limit Requested result count.
 * @param sort Requested ordering.
 * @returns Cache key.
 */
function cacheKey(query, limit, sort) {
  return `${sort}|${limit}|${query}`;
}

/**
 * Perform one GitHub Search API request.
 * @param query Repository search query.
 * @param limit Requested result count.
 * @param sort Requested ordering.
 * @param outerSignal Tool execution cancellation signal.
 * @param settings Resolved plugin settings.
 * @returns Parsed payload and the query that produced it.
 */
async function requestRepositories(query, limit, sort, outerSignal, settings) {
  outerSignal.throwIfAborted();
  if (typeof fetch !== 'function') throw new Error(`${TOOL_NAME} needs the Host \`fetch\` global, which this runtime does not provide`);

  const timeoutSignal = AbortSignal.timeout(settings.timeoutMs);
  const signal = typeof AbortSignal.any === 'function' ? AbortSignal.any([outerSignal, timeoutSignal]) : outerSignal;

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'dsh-github-oss-radar/0.1',
  };
  const token = resolveToken(settings);
  if (token.length > 0) headers.Authorization = `Bearer ${token}`;

  const search = new URLSearchParams({ q: query, per_page: String(limit) });
  if (sort !== 'best-match') {
    search.set('sort', sort);
    search.set('order', 'desc');
  }

  let response;
  try {
    response = await fetch(`${API_URL}?${search.toString()}`, { headers, signal });
  } catch (error) {
    if (outerSignal.aborted) throw new Error(`${TOOL_NAME} was cancelled`);
    if (timeoutSignal.aborted || isAbortError(error)) throw new Error(`${TOOL_NAME} timed out after ${settings.timeoutMs}ms; continue without the list`);
    throw new Error(`${TOOL_NAME} could not reach the GitHub API: ${messageOf(error)}`);
  }

  if (!response.ok) throw new Error(describeHttpFailure(response));

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (outerSignal.aborted) throw new Error(`${TOOL_NAME} was cancelled`);
    throw new Error(`${TOOL_NAME} received an unreadable GitHub response: ${messageOf(error)}`);
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
    throw new Error(`${TOOL_NAME} received an unexpected GitHub response (no \`items\` array)`);
  }

  return {
    query,
    sort,
    totalCount: typeof payload.total_count === 'number' ? payload.total_count : payload.items.length,
    items: payload.items,
    incomplete: payload.incomplete_results === true,
  };
}

/** Resolve the optional GitHub token from config or the Host environment. */
function resolveToken(settings) {
  if (settings.token.length > 0) return settings.token;
  const envToken = typeof settings.tokenEnv === 'string' && settings.tokenEnv.length > 0
    ? process.env[settings.tokenEnv]
    : undefined;
  const raw = envToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Explain a non-OK GitHub response, including rate-limit reset hints. */
export function describeHttpFailure(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (response.status === 403 || response.status === 429) {
    if (remaining === '0' && Number.isFinite(reset)) {
      const when = new Date(reset * 1000).toISOString();
      return `GitHub API rate limit reached (unauthenticated search allows 10 requests per minute); it resets at ${when}. Set GITHUB_TOKEN to raise the limit, or continue without the list.`;
    }
    return `GitHub API refused the search (HTTP ${response.status}); continue without the list.`;
  }
  if (response.status === 422) {
    return 'GitHub rejected the search query as invalid (HTTP 422); retry with simpler keywords or continue without the list.';
  }
  return `GitHub API search failed with HTTP ${response.status} ${response.statusText}`.trim();
}

/* ------------------------------------------------------------------- cache */

/**
 * Create the per-plugin search cache.
 * @param ttlMs Entry lifetime; 0 disables caching.
 * @returns Cache handle.
 */
function createCache(ttlMs) {
  /** @type {Map<string, { at: number, text?: string, result?: object }>} */
  const entries = new Map();
  const enabled = ttlMs > 0;

  const isFresh = (entry) => enabled && Date.now() - entry.at < ttlMs;

  return {
    /** Fresh result text, or null. */
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined || entry.text === undefined) return null;
      return isFresh(entry) ? entry.text : null;
    },
    /** Any result text for this key, even an expired one. */
    getStale(key) {
      const entry = entries.get(key);
      return entry !== undefined && entry.text !== undefined ? entry.text : null;
    },
    /** Store rendered result text. */
    set(key, text) {
      if (!enabled) return;
      entries.delete(key);
      entries.set(key, { at: Date.now(), text });
      while (entries.size > MAX_CACHE_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/* --------------------------------------------------------------- rendering */

/**
 * Format the search payload as a compact, model-readable list.
 * @param result Parsed payload.
 * @param meta Presentation metadata.
 * @returns Result text.
 */
export function formatMatches(result, meta) {
  const header = `GitHub open-source matches for "${meta.keywords.join(' ')}"`;
  const filters = [];
  if (meta.minStars > 0) filters.push(`min ★${formatStars(meta.minStars)}`);
  filters.push(describeSort(meta.sort));
  const lines = [
    header,
    `Query: ${meta.query}`,
    `Matches: ${result.totalCount} total${result.incomplete ? ' (incomplete)' : ''}, showing ${result.items.length}${filters.length > 0 ? ` — ${filters.join(', ')}` : ''}`,
  ];
  if (meta.broadened) lines.push('Note: no match for all keywords, so the query was broadened to the first keyword.');
  lines.push('');

  if (result.items.length === 0) {
    lines.push('No repositories matched. Continue without a list.');
    return lines.join('\n');
  }

  result.items.forEach((item, index) => {
    const name = typeof item.full_name === 'string' ? item.full_name : '(unknown repository)';
    const url = typeof item.html_url === 'string' ? item.html_url : 'https://github.com';
    const language = typeof item.language === 'string' && item.language.length > 0 ? item.language : 'unknown language';
    const pushed = typeof item.pushed_at === 'string' ? item.pushed_at.slice(0, 10) : 'unknown date';
    const stars = Number.isFinite(item.stargazers_count) ? formatStars(item.stargazers_count) : '?';
    const forks = Number.isFinite(item.forks_count) ? formatStars(item.forks_count) : '?';
    const license = licenseNameOf(item);
    lines.push(`${index + 1}. ${name} ★${stars} (${language}, pushed ${pushed}, ${forks} forks, ${license})`);
    lines.push(`   ${url}`);
    const description = typeof item.description === 'string' ? item.description.replace(/\s+/g, ' ').trim() : '';
    lines.push(`   ${description.length > 0 ? description : '(no description)'}`);
    const topics = Array.isArray(item.topics) ? item.topics.filter((topic) => typeof topic === 'string').slice(0, 6) : [];
    if (topics.length > 0) lines.push(`   topics: ${topics.join(', ')}`);
  });

  lines.push('');
  lines.push('Metadata from the GitHub Search API at request time. Verify license and maintenance status before adopting a project.');
  return lines.join('\n');
}

/** Short human label for the ordering used by one search. */
function describeSort(sort) {
  if (sort === 'updated') return 'most recently pushed';
  if (sort === 'best-match') return 'best match';
  return 'sorted by stars';
}

/** License label of one repository payload. */
function licenseNameOf(item) {
  const license = item.license;
  if (!isPlainObject(license)) return 'no license file';
  const spdx = typeof license.spdx_id === 'string' ? license.spdx_id : '';
  if (spdx.length > 0 && spdx !== 'NOASSERTION') return spdx;
  const name = typeof license.name === 'string' ? license.name.trim() : '';
  if (name.length > 0) return name;
  return 'no license file';
}

/** Format a star/fork count compactly (24100 -> 24.1k). */
export function formatStars(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return '?';
  if (count < 1000) return String(Math.round(count));
  if (count < 1000000) {
    const thousands = count / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
}

/* ---------------------------------------------------------------- settings */

/**
 * Resolve the loader row config into safe settings.
 * @param raw Loader row config.
 * @returns Resolved plugin settings.
 */
export function readConfig(raw) {
  const merged = { ...DEFAULT_CONFIG, ...(isPlainObject(raw) ? raw : {}) };
  const tokenEnv = typeof merged.tokenEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(merged.tokenEnv.trim())
    ? merged.tokenEnv.trim()
    : DEFAULT_CONFIG.tokenEnv;
  return {
    enabled: merged.enabled !== false,
    maxResults: clampInteger(merged.maxResults, DEFAULT_CONFIG.maxResults, 1, MAX_LIMIT),
    minStars: clampInteger(merged.minStars, DEFAULT_CONFIG.minStars, 0, 1000000),
    language: sanitizeLanguage(merged.language),
    includeArchived: merged.includeArchived === true,
    cacheTtlMs: clampInteger(merged.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, 0, 3600000),
    timeoutMs: clampInteger(merged.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 60000),
    tokenEnv,
    token: typeof merged.token === 'string' ? merged.token.trim() : '',
  };
}

/* ------------------------------------------------------------------ helpers */

/** Whether a value is a plain JSON record. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a human-readable message from an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Whether an error is an abort/cancellation error. */
function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
