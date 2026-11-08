/**
 * Unit tests for the dsh-github-oss-radar plugin.
 *
 * The plugin has no runtime dependencies and registers raw Host definitions, so
 * the whole contract is testable with a fake plugin context and a stubbed
 * `globalThis.fetch` — nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  composeQuery,
  describeHttpFailure,
  formatMatches,
  formatStars,
  normalizeArgs,
  readConfig,
} from '../index.js';

/* ------------------------------------------------------------------ fixtures */

/** Build a fake plugin context that records what the plugin registers. */
function makeContext() {
  /** @type {object[]} */
  const sections = [];
  /** @type {object[]} */
  const tools = [];
  const ctx = {
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    effect(run) {
      run();
    },
  };
  return { ctx, sections, tools };
}

/** Build one GitHub repository payload. */
function makeItem(overrides = {}) {
  return {
    full_name: 'owner/repo',
    html_url: 'https://github.com/owner/repo',
    description: 'Reusable thing',
    language: 'TypeScript',
    stargazers_count: 24100,
    forks_count: 3200,
    pushed_at: '2026-10-01T12:00:00Z',
    topics: ['cli', 'tooling'],
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    ...overrides,
  };
}

/** Build a fake `fetch` response. */
function makeResponse(payload, { ok = true, status = 200, statusText = '', headers = {} } = {}) {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok,
    status,
    statusText,
    headers: { get: (name) => (normalized.has(name) ? normalized.get(name) : null) },
    async json() {
      return payload;
    },
  };
}

/** Replace `globalThis.fetch` for the duration of one test. */
function withFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

/** Fresh tool execution context. */
function execContext() {
  return { signal: new AbortController().signal };
}

/** Run `apply` and return the registered tool. */
function mount(t, config = {}) {
  const { ctx, sections, tools } = makeContext();
  apply(ctx, config);
  t.after(() => {});
  return { sections, tools, tool: tools[0] };
}

/* -------------------------------------------------------------- query strings */

test('composeQuery joins keywords and always excludes archived repositories', () => {
  assert.equal(composeQuery(['python', 'cli'], '', '', 0, false), 'python cli archived:false');
});

test('composeQuery adds star and language filters and honours includeArchived', () => {
  assert.equal(
    composeQuery(['rust', 'parser'], '', 'Rust', 500, true),
    'rust parser stars:>=500 language:Rust',
  );
});

test('composeQuery lets an exact query override keywords', () => {
  assert.equal(
    composeQuery(['ignored'], 'topic:dsh-plugin', 'JavaScript', 10, false),
    'topic:dsh-plugin stars:>=10 language:JavaScript archived:false',
  );
});

/* ---------------------------------------------------------------- formatting */

test('formatStars compacts counts the way the prompt expects', () => {
  assert.equal(formatStars(0), '0');
  assert.equal(formatStars(999), '999');
  assert.equal(formatStars(1000), '1k');
  assert.equal(formatStars(24100), '24.1k');
  assert.equal(formatStars(100000), '100k');
  assert.equal(formatStars(1500000), '1.5M');
  assert.equal(formatStars(Number.NaN), '?');
});

test('formatMatches lists every repository fact the model needs', () => {
  const text = formatMatches(
    { query: 'cli archived:false', sort: 'stars', totalCount: 1, items: [makeItem()], incomplete: false },
    { keywords: ['cli'], query: 'cli archived:false', limit: 5, minStars: 0, sort: 'stars', broadened: false },
  );

  assert.match(text, /GitHub open-source matches for "cli"/);
  assert.match(text, /Matches: 1 total, showing 1/);
  assert.match(text, /1\. owner\/repo ★24\.1k \(TypeScript, pushed 2026-10-01, 3\.2k forks, MIT\)/);
  assert.match(text, /https:\/\/github\.com\/owner\/repo/);
  assert.match(text, /topics: cli, tooling/);
  assert.match(text, /Metadata from the GitHub Search API/);
});

test('formatMatches reports missing licences instead of hiding them', () => {
  const text = formatMatches(
    { query: 'x archived:false', sort: 'stars', totalCount: 1, items: [makeItem({ license: null })], incomplete: false },
    { keywords: ['x'], query: 'x archived:false', limit: 5, minStars: 0, sort: 'stars', broadened: false },
  );
  assert.match(text, /no license file/);
});

test('formatMatches returns a plain sentence for an empty result', () => {
  const text = formatMatches(
    { query: 'nope archived:false', sort: 'stars', totalCount: 0, items: [], incomplete: false },
    { keywords: ['nope'], query: 'nope archived:false', limit: 5, minStars: 0, sort: 'stars', broadened: false },
  );
  assert.match(text, /No repositories matched\. Continue without a list\./);
});

test('formatMatches explains a broadened query', () => {
  const text = formatMatches(
    { query: 'widget archived:false', sort: 'stars', totalCount: 2, items: [makeItem()], incomplete: false },
    { keywords: ['widget'], query: 'widget archived:false', limit: 5, minStars: 0, sort: 'stars', broadened: true },
  );
  assert.match(text, /broadened to the first keyword/);
});

/* ----------------------------------------------------------------- arguments */

test('normalizeArgs rejects missing keywords and non-object arguments', () => {
  const settings = readConfig({});
  assert.throws(() => normalizeArgs(null, settings), /expects an object argument/);
  assert.throws(() => normalizeArgs({ keywords: [] }, settings), /keywords is required/);
});

test('normalizeArgs caps keyword count at four', () => {
  const settings = readConfig({});
  assert.throws(
    () => normalizeArgs({ keywords: ['a', 'b', 'c', 'd', 'e'] }, settings),
    /at most 4 entries/,
  );
});

test('normalizeArgs clamps limit, sanitizes language and falls back on a bad sort', () => {
  const settings = readConfig({ maxResults: 3 });
  const request = normalizeArgs({ keywords: ['x'], limit: 99, language: 'Bad"Lang', sort: 'nonsense' }, settings);
  assert.equal(request.limit, 10);
  assert.equal(request.language, '');
  assert.equal(request.sort, 'stars');
  assert.equal(normalizeArgs({ keywords: ['x'] }, settings).limit, 3);
});

/* -------------------------------------------------------------------- config */

test('readConfig applies the documented defaults', () => {
  assert.deepEqual(readConfig(), {
    enabled: true,
    maxResults: 5,
    minStars: 0,
    language: '',
    includeArchived: false,
    cacheTtlMs: 600000,
    timeoutMs: 15000,
    tokenEnv: 'GITHUB_TOKEN',
    token: '',
  });
});

test('readConfig clamps out-of-range settings and rejects a malformed tokenEnv', () => {
  const settings = readConfig({ maxResults: 100, cacheTtlMs: -5, timeoutMs: 10, tokenEnv: 'BAD NAME' });
  assert.equal(settings.maxResults, 10);
  assert.equal(settings.cacheTtlMs, 0);
  assert.equal(settings.timeoutMs, 1000);
  assert.equal(settings.tokenEnv, 'GITHUB_TOKEN');
});

test('readConfig only treats a literal true as includeArchived', () => {
  assert.equal(readConfig({ includeArchived: 'yes' }).includeArchived, false);
  assert.equal(readConfig({ includeArchived: true }).includeArchived, true);
});

/* ------------------------------------------------------------------- mounting */

test('apply installs the policy section before the built-in web-search guidance', (t) => {
  const { sections, tools } = mount(t);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'github-oss-radar:policy');
  assert.equal(sections[0].order, 1990);
  assert.match(sections[0].text, /Call `github_search` at most once per request/);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'github_search');
});

test('apply registers nothing when disabled', (t) => {
  const { sections, tools } = mount(t, { enabled: false });
  assert.equal(sections.length, 0);
  assert.equal(tools.length, 0);
});

/* --------------------------------------------------------------------- search */

test('execute renders the search result and sends the documented request', async (t) => {
  /** @type {string[]} */
  const urls = [];
  withFetch(t, async (url) => {
    urls.push(String(url));
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t);
  const text = await tool.execute({ keywords: ['cli', 'tooling'], limit: 2 }, execContext());

  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.origin + url.pathname, 'https://api.github.com/search/repositories');
  assert.equal(url.searchParams.get('q'), 'cli tooling archived:false');
  assert.equal(url.searchParams.get('sort'), 'stars');
  assert.equal(url.searchParams.get('order'), 'desc');
  assert.equal(url.searchParams.get('per_page'), '2');
  assert.match(text, /owner\/repo ★24\.1k/);
});

test('identical searches inside the cache window hit the network once', async (t) => {
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t);
  await tool.execute({ keywords: ['cli'] }, execContext());
  await tool.execute({ keywords: ['cli'] }, execContext());

  assert.equal(calls, 1);
});

test('a different limit is a different search', async (t) => {
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t);
  await tool.execute({ keywords: ['cli'], limit: 2 }, execContext());
  await tool.execute({ keywords: ['cli'], limit: 3 }, execContext());

  assert.equal(calls, 2);
});

test('cacheTtlMs 0 disables caching', async (t) => {
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t, { cacheTtlMs: 0 });
  await tool.execute({ keywords: ['cli'] }, execContext());
  await tool.execute({ keywords: ['cli'] }, execContext());

  assert.equal(calls, 2);
});

test('concurrent identical searches are coalesced into one request', async (t) => {
  let calls = 0;
  /** @type {(value: unknown) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  withFetch(t, async () => {
    calls += 1;
    await gate;
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t);
  const first = tool.execute({ keywords: ['cli'] }, execContext());
  const second = tool.execute({ keywords: ['cli'] }, execContext());
  release(undefined);
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('an empty result for all keywords retries once with the first keyword', async (t) => {
  /** @type {string[]} */
  const queries = [];
  withFetch(t, async (url) => {
    const q = new URL(String(url)).searchParams.get('q');
    queries.push(q);
    const empty = queries.length === 1;
    return makeResponse({
      total_count: empty ? 0 : 1,
      items: empty ? [] : [makeItem()],
      incomplete_results: false,
    });
  });

  const { tool } = mount(t);
  const text = await tool.execute({ keywords: ['quantum', 'widget'] }, execContext());

  assert.deepEqual(queries, ['quantum widget archived:false', 'quantum archived:false']);
  assert.match(text, /broadened to the first keyword/);
});

test('sort=updated and sort=best-match map onto the API parameters', async (t) => {
  /** @type {URL[]} */
  const urls = [];
  withFetch(t, async (url) => {
    urls.push(new URL(String(url)));
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t);
  await tool.execute({ keywords: ['a'], sort: 'updated' }, execContext());
  await tool.execute({ keywords: ['b'], sort: 'best-match' }, execContext());

  assert.equal(urls[0].searchParams.get('sort'), 'updated');
  assert.equal(urls[0].searchParams.get('order'), 'desc');
  assert.equal(urls[1].searchParams.get('sort'), null);
  assert.equal(urls[1].searchParams.get('order'), null);
});

test('a configured token is sent as a bearer header', async (t) => {
  /** @type {Record<string, string>} */
  let headers = {};
  withFetch(t, async (_url, init) => {
    headers = init.headers;
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t, { token: 'ghp_example' });
  await tool.execute({ keywords: ['cli'] }, execContext());

  assert.equal(headers.Authorization, 'Bearer ghp_example');
});

test('no token means no Authorization header', async (t) => {
  /** @type {Record<string, string>} */
  let headers = {};
  withFetch(t, async (_url, init) => {
    headers = init.headers;
    return makeResponse({ total_count: 1, items: [makeItem()], incomplete_results: false });
  });

  const { tool } = mount(t);
  await tool.execute({ keywords: ['cli'] }, execContext());

  assert.equal(headers.Authorization, undefined);
});

test('a rate-limited response explains the reset time and points at GITHUB_TOKEN', async (t) => {
  withFetch(t, async () => makeResponse(
    { message: 'API rate limit exceeded' },
    { ok: false, status: 403, statusText: 'Forbidden', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000000' } },
  ));

  const { tool } = mount(t);
  await assert.rejects(
    tool.execute({ keywords: ['cli'] }, execContext()),
    /rate limit reached[\s\S]*resets at 2025[\s\S]*GITHUB_TOKEN/,
  );
});

test('a rejected query is reported as invalid instead of as a crash', async (t) => {
  withFetch(t, async () => makeResponse({}, { ok: false, status: 422, statusText: 'Unprocessable Entity' }));
  const failure = describeHttpFailure({ status: 422, statusText: 'Unprocessable Entity', headers: { get: () => null } });
  assert.match(failure, /invalid \(HTTP 422\)/);

  const { tool } = mount(t);
  await assert.rejects(tool.execute({ keywords: ['cli'] }, execContext()), /HTTP 422/);
});

test('a missing fetch global fails with a readable message', async (t) => {
  const original = globalThis.fetch;
  // @ts-expect-error — deliberately removing the global for this test.
  delete globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const { tool } = mount(t);
  await assert.rejects(tool.execute({ keywords: ['cli'] }, execContext()), /needs the Host `fetch` global/);
});

test('a cancelled tool call stops before any request', async (t) => {
  let calls = 0;
  withFetch(t, async () => {
    calls += 1;
    return makeResponse({ total_count: 0, items: [], incomplete_results: false });
  });

  const { tool } = mount(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(tool.execute({ keywords: ['cli'] }, { signal: controller.signal }), /cancelled|abort/i);
  assert.equal(calls, 0);
});
