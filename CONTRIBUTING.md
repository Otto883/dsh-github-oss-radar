# Contributing

## Development setup

Requirements: Node.js `22.19.0` or newer. There is no build step and no runtime dependency to install.

```
git clone https://github.com/Otto883/dsh-github-oss-radar.git
cd dsh-github-oss-radar
npm test
```

- `npm test` runs the suite with Node's built-in test runner (`node --test test/*.test.mjs`).
- `node --check index.js` performs a syntax check on the plugin entry point.

## Style

- ESM only (`"type": "module"`); use `import` and `export`.
- Zero runtime dependencies: use the Host `fetch` global and Node built-ins.
- JSDoc on exported functions and on non-obvious internals, following the existing comments.
- No new network calls. The plugin may contact `https://api.github.com/search/repositories` only.
- Keep the prompt policy and tool descriptions stable unless the change is intentional; both are part of the plugin's behaviour.
- No emoji in code or documentation.

## Proposing a change

- For behaviour changes (the prompt policy, tool arguments, query composition, config keys), open an issue first and describe the current behaviour and the proposed one.
- Keep pull requests small and focused; do not mix refactors with behaviour changes.
- Add or update tests under `test/` for any behaviour change.
- Update `CHANGELOG.md` under `[Unreleased]`.
- In the pull request, describe what changed and why, and mention any compatibility impact on the prompt, tool arguments, config, or output format.

## Versioning

The project follows Semantic Versioning:

- MAJOR for incompatible changes to the prompt policy, tool name, tool arguments, config keys, or the output format.
- MINOR for new tool arguments, new config keys, or backward-compatible behaviour.
- PATCH for fixes that do not change the contract.

## Commit messages

Use Conventional Commits and one logical change per commit, for example:

```
feat: add updated sort order
fix: report rate-limit reset time
docs: clarify the tokenEnv default
test: cover the keyword broadening retry
```
