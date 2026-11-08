# Security Policy

## Scope

`dsh-github-oss-radar` is a DeepSeek Harness bundle. It adds one system-prompt section (`github-oss-radar:policy`) and one Host tool (`github_search`). It does not run a server, listen on a port, or execute downloaded code.

## What the plugin can reach

- One network destination: `https://api.github.com/search/repositories`, over HTTPS, GET requests only.
- Query strings are built from the model-supplied keywords or query plus the loader configuration; the response is read and formatted as text.
- No other hosts, URLs, or protocols are contacted.

## What it reads from the environment

One optional token, taken from `GITHUB_TOKEN` or `GH_TOKEN`, or from the variable named by the `tokenEnv` config key (default `GITHUB_TOKEN`). An optional `token` config key exists as well, but the environment variable is the recommended route.

A token is used only as the `Authorization: Bearer` header for api.github.com. It is never logged, never written to disk, never included in tool output, and never sent to any other host. No token is required; without one the anonymous Search API limit of 10 requests per minute applies.

## What it writes

- Nothing on disk.
- An in-memory cache only: formatted responses are kept for 10 minutes (`cacheTtlMs`) so repeated and concurrent identical requests do not consume the API budget. The cache disappears when the Host process exits.
- No telemetry, analytics, or crash reporting.

## API budget and failure behaviour

- At most one search per new request. Identical concurrent requests are coalesced into one call.
- Rate-limit rejections report the reset time and suggest setting `GITHUB_TOKEN`; the model is told to continue without the list rather than retrying.

## Third-party data

Repository metadata comes from the GitHub Search API at request time. A repository appearing in a result is not a security audit: license, maintenance status, dependencies, and code must be verified before adopting a project. The tool output includes that reminder.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on the repository:

https://github.com/Otto883/dsh-github-oss-radar/security/advisories/new

Do not open a public issue for a vulnerability report. Include the affected version, reproduction steps, and impact, and allow time for a fix before any public disclosure.
