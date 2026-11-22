# pi-dsweb

用 DeepSeek 官方 [网页搜索与抓取 API](https://api-docs.deepseek.com/zh-cn/guides/search) 给 pi 提供 `web_search` 和 `web_fetch` 两个工具。

- **与对话模型无关**：主力模型用什么都行，只要有一个 DeepSeek API key。
- **直接调 REST**：不经过模型补全，不消耗 token，只按请求计费。
- **零运行时依赖**：只用 Node 自带的 `fetch`。

## 安装

```bash
cd pi-dsweb && npm install
pi install npm:@aoshizuku/pi-dsweb                # 从 npm 安装
pi install git:github.com/AoShizuku/pi-dsweb     # 或从 GitHub 安装
pi install ./pi-dsweb      # 或临时加载：pi -e ./pi-dsweb/src/index.ts
```

API key 按以下顺序查找：

1. pi 自己的 DeepSeek 凭据：`/login` 选 DeepSeek，或 `auth.json` / provider 配置。
2. 环境变量 `DEEPSEEK_API_KEY`。

## 工具

### `web_search`

| 参数 | 说明 |
|---|---|
| `query` | 必填。连同运算符最多 128 个字符（按 Unicode 字符计）。 |
| `count` | 1–50，默认 10。**不影响价格**。 |
| `question` | 可选。用户的原始问题，作为 `ori_question` 发送，帮助按意图排序；超过 128 字符会被截断，不会报错。 |
| `include_content` | 可选。同时返回每条结果的正文（`need_content`）。 |

`query` 支持的运算符，可以组合使用：

| 运算符 | 示例 |
|---|---|
| `site:` | `site:github.com OR site:huggingface.co` |
| `-site:` | `-site:example.com` |
| `-` | `-广告` |
| `"..."` / `-"..."` | `"精确短语"` / `-"release notes"` |
| `lang:` | `lang:zh,en` |
| `after:` / `before:` | `after:2025-01-01` / `before:2026` |

每条结果的输出依次是：标题、URL、`站点 · 日期 · score · authority`，最后是 `summary`。

- `summary` 是官方给模型读的 600–800 字摘要，没有时退回 `snippet`。
- `score` 即 `rerank_score`，范围 0–3，≥1.5 算高质量。
- `authority` 范围 0–4；值为 -1 表示未知，此时不显示。
- 开了 `include_content` 时，每条正文在输出里最多保留 4000 字符。被截断时，完整结果写进临时文件，并把路径告诉模型。

### `web_fetch`

| 参数 | 说明 |
|---|---|
| `url` | 必填。http(s)，带 host，不能带用户名密码，最长 8192。 |

返回 `Title / URL` 加上页面的 Markdown 正文。

- 输出上限沿用 pi 内置工具的标准：2000 行 / 50KB。
- 超出部分会把完整 Markdown 写到 `<系统临时目录>/pi-dsweb/fetch-*.md`，模型可以用 `read` 加 `offset` 接着读。
- 返回 200 但正文为空时按失败处理。

## 错误与重试

对照官方错误码表处理：

| 状态码 | 处理 |
|---|---|
| 408 / 429 / 5xx / 网络错误 | 自动重试 2 次。有 `Retry-After` 时按它等待（最多 10s），否则依次等 1s、2s。**例外：Fetch 的 504 不重试**——它表示目标页面加载超时（服务端约 30s，实测大 PDF 会触发），重试同一个 URL 还是超时，3 次就要白等 90s。 |
| 400 / 401 / 402 / 403 / 404 / 413 | 不重试，直接把原因告诉模型。例如 401 提示配置 key，402 提示充值；404 是 Fetch 拿不到可用正文（页面不可用、被站点策略拦截、内容类型不支持、没有可提取的正文）。 |

错误信息里出现的 API key 会被替换成 `***`。

每次请求单独设超时：Search 30s，Fetch 60s。官方文档没有给出服务端超时，这两个值是自定的。用户中断（Esc）会立即取消请求和重试等待。

## 限速与计费（官方）

| API | QPS（按账号，跟用哪个 key 无关） | 价格 |
|---|---|---|
| Search | 100 | 5 元 / 千次成功请求 |
| Fetch | 25，另有未公开的单目标域名 QPS 限制 | 5 元 / 千次成功请求 |

只有返回结果的 200 请求计费。空结果、失败和超时都不计费。

## 显示

两个工具都画成和 pi 紧凑工具行对齐的一行（`renderShell: "self"`，不套背景框）：

- **折叠时**：`● Web Search (query) · 10 results`，或 `● Web Fetch (url) · 标题 · 320 lines · 18.2KB`。运行中标记为强调色、摘要为 `Searching…` / `Fetching…`；成功为绿色；失败为红色 `×`，摘要为错误首行。
- **展开时**：在标题下缩进列出全部搜索结果（标题、域名、日期），或预览抓取正文前 40 行。

## 开发

```bash
npm run check    # tsc + vitest
```

## 实测记录（2026-11-09）

- Search 每次约 0.4s。实际返回的 `summary` 往往比文档写的 600–800 字更长，是用 `...` 拼起来的多段摘录，5 条结果约 9KB。
- 即使查一个不存在的词，Search 也会返回低分结果（score 约 0.5），而不是空列表。可以靠 score 判断相关性。
- 返回的 URL 有时带 `#1` 之类的锚点，title 也可能为空，为空时用域名代替。
- Fetch 普通页面 0.2–15s。返回的 Markdown **没有**多余的反斜杠转义（第三方插件 pi-web-access 说观察到会转义，本插件实测没有遇到），照原样返回。行内代码的反引号会丢失，例如 `` `node:fs` `` 变成 `Thenode:fs`，这是服务端转换的问题。
- Fetch 拿不到的情况：
  - 维基百科（中英文都一样）秒回 404 `failed to fetch URL`。
  - arXiv 的 PDF 约 30s 后返回 504。
- 长页面截断已验证：nodejs.org/api/fs.html 共 5282 行 / 186KB，输出前 1367 行 / 49.9KB，完整内容落盘。

## 未覆盖

- `localization`（按 IP 偏好本地化结果）这个参数没有开放给模型。

---

本插件属于 Shizuku 系列 pi 插件（[pi-shizuku](https://github.com/AoShizuku/pi-shizuku)）：共用的左栏、设计语言与跨插件约定见总仓库。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
