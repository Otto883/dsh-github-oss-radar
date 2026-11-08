# dsh-github-oss-radar

一个常驻的 DeepSeek Harness（dsh）插件包：为配置（profile）中的每个 Agent 安装一套常驻策略——每次收到新请求时，模型先提取关键词，调用一次有预算的 `github_search` 工具，然后才在回答中列出真正相关的可复用开源项目（如果有）。

- 包：`dsh-github-oss-radar` 0.1.0，MIT
- 仓库：https://github.com/Otto883/dsh-github-oss-radar
- ESM，零运行时依赖，已在 dsh `0.1.7-rc.2` 上验证

## 为什么用这个插件而不是 skill

- skill 只有在模型主动决定加载时才会执行。本插件安装的是系统提示词策略，因此每次新请求都会执行检查，不需要模型先做决定。
- 策略本身带有预算：每个请求最多调用一次 `github_search`；相同的并发请求会合并为一次调用；响应在内存中缓存 10 分钟。
- 项目列表只是起点，不能替代回答本身。策略要求搜索不得拖延回答，也绝不替代阅读用户自己的文件；同一话题内的追问不会重复搜索。

## 安装了什么

两部分都会注册到该配置里的每个 Agent。

| 类型 | 名称 | 作用 |
| --- | --- | --- |
| 系统提示词段落 | `github-oss-radar:policy` | 以 order `1990` 插入，正好位于内置的 web 搜索指引之前。要求模型对每个新请求提取 1-4 个英文关键词，在回答前调用一次 `github_search`，以 `owner/repo`（★ 数）形式列出最多 5 个（可配置）真正相关的仓库，每个仓库一行说明它做什么、为什么适合，并附上 URL。没有相关项目时用一行说明。 |
| Host 工具 | `github_search` | 调用 `https://api.github.com/search/repositories`，返回便于模型阅读的紧凑仓库列表。 |

工具接受以下参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `keywords` | 1-4 个字符串组成的数组 | 用英文描述技术、领域或任务的 1-4 个关键词。未提供 `query` 时必填。关键词以空格连接，因此按 AND 语义组合。 |
| `query` | 字符串 | 精确的 GitHub 仓库搜索语句。存在时覆盖 `keywords`。 |
| `language` | 字符串 | 可选的 GitHub 语言过滤，例如 `Python` 或 `TypeScript`。 |
| `min_stars` | 整数 | 最低 star 数。默认取插件配置 `minStars`。 |
| `limit` | 整数，1-10 | 返回的仓库数量。默认取插件配置 `maxResults`。 |
| `sort` | `stars`、`updated` 或 `best-match` | 结果排序方式，默认 `stars`。 |

组合出的搜索语句由空格连接的关键词组成；设置了最低 star 数时追加 `stars:>=N`，设置了语言时追加 `language:X`，未开启 `includeArchived` 时追加 `archived:false`。如果完整关键词没有匹配到任何仓库，且未提供精确的 `query`，工具会用第一个关键词再试一次。

每条结果包含 `owner/repo`、紧凑格式的 star 数（例如 `24.1k`）、URL、一行描述、语言、GitHub 报告时给出的 license SPDX id、最后推送日期、fork 数，以及最多 6 个 topics。输出末尾会注明：元数据来自请求时的 GitHub Search API，采用项目前应自行核实 license 与维护状态。零结果时返回明确的 `No repositories matched` 行，而不是报错。

## 安装

从 GitHub 安装：

```
dsh plugin --profile <profile> add github:Otto883/dsh-github-oss-radar
```

插件市场上架后，也可以在市场卡片中直接添加。

npm 发布后：

```
dsh plugin --profile <profile> add dsh-github-oss-radar
```

然后重启 dsh。插件补丁会在配置根部插入 `github-oss-radar` 加载器行，提示词段落和工具随之出现在每个 Agent 中。

## 配置

配置写在 `github-oss-radar` 加载器行上，例如配置文件的 `cordis.patch.yml` 中：

```yaml
- id: github-oss-radar
  config:
    maxResults: 5
    minStars: 1000
    language: TypeScript
    cacheTtlMs: 600000
```

| 配置键 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- |
| `enabled` | `true` | 布尔值 | 设为 `false` 时跳过提示词段落和工具。 |
| `maxResults` | `5` | 1-10 | 最多列出的仓库数量；同时限制模型可请求的 `limit`。 |
| `minStars` | `0` | 0-1000000 | 搜索时应用的最低 star 数。 |
| `language` | `''` | 字符串 | 默认的 GitHub 语言过滤。空字符串表示不设默认值。 |
| `includeArchived` | `false` | 布尔值 | 为 `false` 时，每个查询都带 `archived:false`。 |
| `cacheTtlMs` | `600000` | 0-3600000 | 内存响应缓存的存活时间，单位毫秒（10 分钟）。 |
| `timeoutMs` | `15000` | 1000-60000 | GitHub API 调用的单次超时，单位毫秒。 |
| `tokenEnv` | `'GITHUB_TOKEN'` | 字符串 | 读取可选令牌的环境变量名。 |

## 结果格式示例

以下为示意输出，仅保留请求的 5 条中的 3 条。真实的头部会打印组合后的查询、匹配总数和展示行数。

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

## 速率限制与令牌

未认证的 GitHub Search API 请求限制为每分钟 10 次。插件通过以下设计留出余量：每个新请求最多搜索一次；相同的并发请求合并为一次调用；响应在内存中缓存 10 分钟（`cacheTtlMs`）。

当 GitHub 因限流拒绝搜索时，工具会报告重置时间并建议设置 `GITHUB_TOKEN`；策略要求模型不再重试，直接在没有列表的情况下继续回答。

令牌是可选的。插件会从 Host 环境读取 `GITHUB_TOKEN` 或 `GH_TOKEN`。`tokenEnv` 指定要读取的变量名（默认 `GITHUB_TOKEN`）。另有一个可选的 `token` 配置键，但推荐使用环境变量。没有令牌也能工作；此时适用未认证的每分钟 10 次限制。

## 运行要求

- dsh `0.1.7-rc.2`（已验证兼容）。
- Host 运行时需要 Node.js `22.19.0` 或更高版本；插件使用全局 `fetch` 和 Node 内置模块。
- 无运行时依赖。

## 卸载

在插件市场的卡片上移除插件包，或用包管理器从配置里卸载：

```
dsh plugin --profile <profile> remove dsh-github-oss-radar
```

移除后会同时删除 `github-oss-radar:policy` 提示词段落和 `github_search` 工具。

## 开发

```
npm test
node --check index.js
```

没有构建步骤，也不需要安装依赖。测试使用 Node 内置测试运行器（`node --test test/*.test.mjs`）。本包必须保持零运行时依赖，只使用 Host 全局能力和 Node 内置模块。

## 许可证

MIT。Copyright (c) 2026 Otto883。见 [LICENSE](LICENSE)。
