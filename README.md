# dsh-github-oss-radar

A persistent DeepSeek Harness (dsh) bundle that gives every agent in a profile a standing GitHub-first open-source check: on each new request the model extracts keywords, calls one budgeted `github_search` tool, and lists the reusable repositories that genuinely fit, if any, before it answers.

- Package: `dsh-github-oss-radar` 0.1.0, MIT
- Repository: https://github.com/Otto883/dsh-github-oss-radar
- ESM, zero runtime dependencies, verified on dsh `0.1.7-rc.2`

## Why this instead of a skill

- A skill runs only when the model decides to load it. This bundle installs a system-prompt policy instead, so the check happens on every new request without a decision step.
- The policy is budgeted on purpose: at most one `github_search` call per request, identical concurrent requests coalesced into one, and responses cached in memory for 10 minutes.
- The list is a starting point, not a substitute for the answer. The policy says the search must not delay the response and never replaces reading the user's own files, and a follow-up inside the same subject does not repeat the search.

## What it installs

Both parts are registered for every agent of the profile.

| Kind | Name | Effect |
| --- | --- | --- |
| System-prompt section | `github-oss-radar:policy` | Added at order `1990`, just before the built-in web-search guidance. Tells the model to extract 1-4 English keywords from each new request, call `github_search` once before answering, and list up to 5 (configurable) genuinely relevant repositories as `owner/repo` (★ count) with one line on what each does and why it fits, plus the URL. When nothing is relevant it says so in one line. |
| Host tool | `github_search` | Searches `https://api.github.com/search/repositories` and returns a compact, model-readable list of repositories. |

The tool accepts these arguments:

| Argument | Type | Description |
| --- | --- | --- |
| `keywords` | array of 1-4 strings | English technical keywords naming the technology, domain, or task. Required unless `query` is given. Joined with spaces, so keywords are combined with AND semantics. |
| `query` | string | Exact GitHub repository search query. Overrides `keywords` when present. |
| `language` | string | Optional GitHub language filter, for example `Python` or `TypeScript`. |
| `min_stars` | integer | Minimum star count. Defaults to the plugin setting (`minStars`). |
| `limit` | integer, 1-10 | Number of repositories to return. Defaults to the plugin setting (`maxResults`). |
| `sort` | `stars` or `updated` or `best-match` | Result ordering. Defaults to `stars`. |

The composed query is the keywords joined with spaces, plus `stars:>=N` when a minimum star count is set, plus `language:X` when a language is set, plus `archived:false` unless `includeArchived` is on. If the full keyword set matches no repository and no explicit `query` was given, the tool retries once, broadened to the first keyword.

Each result row carries `owner/repo`, a compact star count (for example `24.1k`), the URL, a one-line description, the language, the license SPDX id when GitHub reports one, the last push date, the fork count, and up to 6 topics. The output ends with a line noting that the metadata came from the GitHub Search API at request time and that the reader should verify license and maintenance before adopting a project. A zero-result search returns a clear `No repositories matched` line instead of an error.

## Install

From GitHub:

```
dsh plugin --profile <profile> add github:Otto883/dsh-github-oss-radar
```

From the plugin market once the package is listed, add the bundle from its card.

From npm after publication:

```
dsh plugin --profile <profile> add dsh-github-oss-radar
```

Then restart dsh. The bundle patch inserts the `github-oss-radar` loader row at the profile root, and the prompt section and tool appear in every agent.

## Configuration

Configuration lives on the `github-oss-radar` loader row, for example in the profile's `cordis.patch.yml`:

```yaml
- id: github-oss-radar
  config:
    maxResults: 5
    minStars: 1000
    language: TypeScript
    cacheTtlMs: 600000
```

| Key | Default | Range | Description |
| --- | --- | --- | --- |
| `enabled` | `true` | boolean | Set to `false` to skip both the prompt section and the tool. |
| `maxResults` | `5` | 1-10 | Maximum number of repositories listed; also caps the `limit` the model can request. |
| `minStars` | `0` | 0-1000000 | Minimum star count applied to searches. |
| `language` | `''` | string | Default GitHub language filter. Empty means no default. |
| `includeArchived` | `false` | boolean | When `false`, every query includes `archived:false`. |
| `cacheTtlMs` | `600000` | 0-3600000 | Lifetime of the in-memory response cache, in milliseconds (10 minutes). |
| `timeoutMs` | `15000` | 1000-60000 | Per-request timeout for the GitHub API call, in milliseconds. |
| `tokenEnv` | `'GITHUB_TOKEN'` | string | Name of the environment variable read for an optional token. |

## Example of the result format

Illustrative output, trimmed to three of the requested five entries. The real header prints the composed query, the total match count, and the number of rows shown.

```
GitHub open-source matches for "markdown parser"
Query: markdown parser archived:false
Matches: 1284 total, showing 5 — sorted by stars

1. markdown-it/markdown-it ★19.2k (JavaScript, pushed 2026-10-30, 1.8k forks, MIT)
   https://github.com/markdown-it/markdown-it
   Markdown parser done right. Fast and easy to extend.
   topics: markdown, commonmark, parser, javascript

2. remarkjs/remark ★7.9k (JavaScript, pushed 2026-10-28, 512 forks, MIT)
   https://github.com/remarkjs/remark
   Markdown processor powered by plugins.
   topics: markdown, syntax-tree, plugins

3. comrak/comrak ★1.9k (Rust, pushed 2026-10-27, 121 forks, MIT)
   https://github.com/comrak/comrak
   CommonMark + GFM compatible Markdown parser and renderer.
   topics: markdown, commonmark, gfm, rust

Metadata from the GitHub Search API at request time. Verify license and maintenance status before adopting a project.
```

## Rate limits and tokens

Unauthenticated requests to the GitHub Search API are limited to 10 requests per minute. The bundle is designed to stay inside that budget: at most one search per new request, identical concurrent requests coalesced into a single call, and responses cached in memory for 10 minutes (`cacheTtlMs`).

When GitHub does reject a search for rate limiting, the tool reports the reset time and suggests setting `GITHUB_TOKEN`; the policy tells the model to continue without the list rather than retrying.

A token is optional. The plugin reads `GITHUB_TOKEN` or `GH_TOKEN` from the Host environment. The `tokenEnv` key names the variable that is read (default `GITHUB_TOKEN`). An optional `token` config key exists as well, but the environment variable is the recommended route. No token is required; without one, the anonymous 10 requests per minute limit applies.

## Requirements

- dsh `0.1.7-rc.2` (verified compatible).
- Node.js `22.19.0` or newer for the Host runtime; the plugin uses the global `fetch` and Node built-ins.
- No runtime dependencies.

## Uninstall

Remove the bundle from its card in the plugin market, or uninstall the package from the profile with the package manager:

```
dsh plugin --profile <profile> remove dsh-github-oss-radar
```

Removing the bundle removes both the `github-oss-radar:policy` prompt section and the `github_search` tool.

## Development

```
npm test
node --check index.js
```

There is no build step and no dependency install. Tests run on Node's built-in test runner (`node --test test/*.test.mjs`). The package must keep zero runtime dependencies and use only Host globals and Node built-ins.

## License

MIT. Copyright (c) 2026 Otto883. See [LICENSE](LICENSE).
