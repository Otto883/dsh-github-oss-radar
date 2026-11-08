# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-08

### Added

- Standing `github-oss-radar:policy` system-prompt section at order 1990, placed just before the built-in web-search guidance.
- `github_search` Host tool that searches GitHub repositories by 1-4 keywords or an exact query, with optional language, minimum-star, limit, and sort arguments.
- Budgeted search: at most one call per request, a 10-minute in-memory response cache (`cacheTtlMs`) with coalescing of identical concurrent requests, and one broadening retry to the first keyword when the full keyword set matches nothing.
- Results with stars, URL, one-line description, language, license SPDX id when GitHub reports one, last push date, forks, and up to 6 topics, plus a reminder to verify license and maintenance before adopting.
- Rate-limit messages that report the reset time and suggest setting `GITHUB_TOKEN`; the model is told to continue without the list.
- Configurable `github-oss-radar` loader row: `enabled`, `maxResults`, `minStars`, `language`, `includeArchived`, `cacheTtlMs`, `timeoutMs`, `tokenEnv`.

[Unreleased]: https://github.com/Otto883/dsh-github-oss-radar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Otto883/dsh-github-oss-radar/releases/tag/v0.1.0
