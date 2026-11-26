<h1 align="center">dsh-literature-agents</h1>

<p align="center">文学与古典文献研究插件 · DeepSeek Harness</p>

<p align="center">
  <a href="https://github.com/yujh129/dsh-literature-agents"><img src="https://img.shields.io/badge/version-1.0.1-4176E6?style=flat-square" alt="version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT license"></a>
  <a href="#兼容性"><img src="https://img.shields.io/badge/DSH-0.2.1--rc.2%20~%200.3.x-3B82F6?style=flat-square" alt="DSH version range"></a>
  <a href="https://github.com/yujh129/dsh-literature-agents/stargazers"><img src="https://img.shields.io/github/stars/yujh129/dsh-literature-agents?label=stars&style=flat-square&color=D9A400" alt="GitHub stars"></a>
</p>

<p align="center"><a href="#安装">安装</a> · <a href="#能力9-个工具">能力</a> · <a href="#专家与评审团">专家</a> · <a href="#使用示例">用法</a> · <a href="#输入区古籍开关">开关</a> · <a href="#配置">配置</a> · <a href="#兼容性">兼容性</a> · <a href="#开发自检">开发</a> · <a href="#english">English</a></p>

给 DeepSeek Harness 加一张文献研究工作台：**9 个工具**（论文检索、学人生平、古籍检索与阅读、有据今译、引文核验）、**11 位文史专家子代理**、**3 个并行评审团**、一份分层检索与引用核验的研究协议技能，以及输入区一个按对话启停整套能力的**「古籍」开关**。

每个检索类输出都带一行 `数据源：… ✓/✗（原因）`：源失败时如实降级并给出线索，不补造结果、不编 DOI。

## 安装

需要 **DSH ≥ 0.2.1-rc.2**（包内 `engines.dsh` 声明 `>=0.2.1-rc.2 <0.4.0-0`）。不需要手动准备 Node 或 pnpm，宿主会用自己的运行时安装。

**DSH Desktop**：打开「插件」页 → **Add plugin / 添加插件** → 输入 `github:yujh129/dsh-literature-agents` → 安装 → 点 **Enable now**（立即启用），然后重启 DSH。

桌面版的 profile 由应用自己管理：不要用命令行的 `--profile web` 装（那会装进另一个 profile，桌面版看不到），也不要用 `--profile desktop`（会被拒绝，或要求先完全退出桌面版）。

**普通 `dsh web`**：

```sh
dsh plugin --profile web add github:yujh129/dsh-literature-agents
```

装完重启 `dsh web`。

装完**重启 DSH**（桌面版点侧边栏重启按钮，或整个退出再开）。新开一个对话即可看到工具与输入区开关。

<details>
<summary>其他安装方式 / 更新 / 卸载</summary>

从本地压缩包装（内网或连不上 GitHub 时）：

```sh
dsh plugin --profile web add C:\path\to\dsh-literature-agents-1.0.1.tgz
```

让对话里的 agent 代装：

```text
plugin_manager install_bundle target="github:yujh129/dsh-literature-agents"
```

更新：桌面版在「插件」页点该插件的更新；命令行（`dsh web`）把版本号换成 `#v1.0.1` 重新 add：

```sh
dsh plugin --profile web add github:yujh129/dsh-literature-agents#v1.0.1
```

卸载（同时清掉 profile 的 `dependencies` 与 `dsh.profile.bundles` 条目）：

```sh
dsh plugin --profile web remove dsh-literature-agents
```

</details>

## 能力（9 个工具）

| 能力 | 工具 | 数据源 |
| --- | --- | --- |
| 论文检索 | `search_scholar_papers` | Crossref、OpenAlex，宿主网页搜索兜底 |
| 学人生平 | `get_scholar_biography` | Wikidata（属性级溯源）+ OpenAlex 著作 |
| 古籍检索 | `search_classic_texts` | 中文维基文库全文检索 |
| 古籍阅读 | `get_classic_text` | 中文维基文库页面正文 |
| 古籍翻译 | `translate_classic` | 先检索平行文本与旧注，再由翻译专家今译 / 英译 |
| 引文核验 | `verify_citation` | Crossref DOI、题名相似度 |
| 专家召唤 | `summon_literature_expert` | 11 位文史专家子代理 |
| 评审团 | `run_literature_panel` | 3 个并行评审团 |
| 专家名册 | `list_literature_experts` | 列出全部专家、领域与评审团 |

9 个工具全部只读（检索 + 子代理运行），因此都声明了 `isConcurrencySafe`，可以在一轮里并行调用。

## 专家与评审团

11 位专家分布在 5 个领域：

| 领域 | 专家 |
| --- | --- |
| 史学与人物 | 史学史专家 `historiographer`、学人行实考据专家 `biographer` |
| 文献考据 | 校勘学家 `textual-critic`、目录版本学家 `bibliographer`、训诂学家 `philologist` |
| 古籍翻译 | 古籍翻译家 `classics-translator`、注疏专家 `scholia-expert` |
| 文学研究 | 文学批评家 `literary-critic`、比较文学学者 `comparatist` |
| 数字人文与核验 | 数字人文研究者 `digital-humanist`、学术核验员 `citation-auditor` |

3 个评审团各自召集成员独立作答，再由主会话核验证据、去重、按严重级别汇总：

- 古籍考据评审团 `classics-research-panel`：目录 + 校勘 + 训诂 + 注疏
- 文学研究评审团 `literature-review-panel`：史学史 + 文学批评 + 比较文学 + 引用核验
- 古籍翻译审校团 `translation-review-panel`：译文 + 旧注 + 训诂 + 引用

## 使用示例

```text
帮我找几篇关于明清私家修史的论文，给出 DOI
《史记·项羽本纪》鸿门宴那段原文，帮我读一下并翻译成现代汉语
查一下陈寅恪的生平，给出可核验的来源
这条引文真实存在吗：「礼失求诸野」出自《汉书·艺文志》
```

典型链路：`search_classic_texts` → `get_classic_text` → `translate_classic`；证据不足时工具会明说「未检得」，而不是编一条出处。

## 输入区「古籍」开关

输入框左侧工具行有一个「古籍」开关（槽位 `conversation.input.left`，id `literature-toggle`，详见 `client.js`）：

- **开（品牌色圆点）**：本对话可调用 9 个文献工具，系统提示中含专家引导段。
- **关（灰色圆点）**：在该会话的 Agent 上下文里 `tools.restrict({ deny })` 隐藏全部 9 个工具并移除引导段；其他对话不受影响。
- **默认开启**：新对话继承「开」；只有显式关过（写入 `false`）的会话才是关闭状态。
- 状态按 `SessionId` 存在 `~/.dsh/dsh-literature-agents/toggles.json`（`DSH_HOME` 优先），重启后仍在。
- 切换立即作用于该会话的 Agent；若某一轮正在生成，从下一模型步开始生效。
- 这是**用户专属**操作：不提供对应的 Agent 工具，模型无法自行开关。

门控与两个路由都在 `index.js`：`GET /plugins/dsh-literature-agents/state?session=<id>`、`POST /plugins/dsh-literature-agents/toggle`。没有 Web 服务（如纯 TUI）时按钮不存在，工具照常可用。

## 技能

`skills/literature-research/SKILL.md` 由第二条 Host 行（`@deepseek-ai/dsh-skill-filesystem`）挂载，内容为分层检索、事实纪律、生平考据、古籍阅读、翻译规范与引用核验清单。

`@deepseek-ai/dsh-skill-filesystem` 由 `@deepseek-ai/dsh-base` 提供（每个 profile 的第一个 bundle），插件不 import 它、也不声明 `peerDependencies`——声明会让 pnpm 在 profile 里再装一份旧版本，反而遮蔽宿主自带的那份。

## 配置

```yaml
- id: literature-agents
  name: dsh-literature-agents
  config:
    provider: spawn   # 子代理 provider；默认 spawn
    maxDepth: 1       # 召唤出的专家最多再委派一层；provider 不支持 depthLimit 时自动省略
```

`provider` 写错时不会静默失败：错误信息会列出宿主当前注册的 provider 名。DSH < 0.2.2 用 `ctx.subagents.list()` 枚举；0.2.2 起该 API 被移除，插件改用 `ctx.subagents.getProvider(name)` 逐个探测 `spawn` / `fork`，找不到时交由宿主报出真实的缺 provider 错误。

## 兼容性

| DSH 版本 | 状态 |
| --- | --- |
| `0.2.1-rc.2` ~ `0.2.1` | 支持（开发基线） |
| `0.2.2-rc.5`（当前桌面版） | 已在真实宿主上验证：工具注册、开关路由、门控、专家运行 |
| `0.3.x` | 声明支持（`<0.4.0-0`），未逐版验证 |
| `0.1.x` / `0.2.0` | 不支持 |

兼容性由包内顶层 `engines.dsh` 声明（`>=0.2.1-rc.2 <0.4.0-0`），市场与宿主都按这一条判断；插件不声明 `@deepseek-ai/dsh-*` 的 `peerDependencies`，以免 pnpm 复制一份宿主运行时。

## 开发自检

四个离线测试（不联网、不写用户状态、不装依赖）：

```sh
npm test                 # 全部
npm run smoke:manifest   # package.json / cordis.patch.yml / locale / SKILL.md / README 是否满足市场与宿主约定
npm run smoke:host       # index.js：9 个工具的参数是合法 JSON Schema，开关路由与门控行为
npm run smoke:client     # client.js：模块 id、槽位注册与开关状态机（含失败重试）
```

`dev/` 不在 `files` 里，不会被发布出去。

## 数据源与网络

- 必需：Crossref、OpenAlex、Wikidata、中文维基文库。
- 可选：宿主网页搜索服务，仅作兜底与线索。
- 已知不可达（作者本机实测）：zh.wikipedia.org、ctext.org、Semantic Scholar、Gutendex；这些源不参与主链路，只在输出中作为引用地址出现。
- Wikimedia 在共享 IP 上常见 `403 Too Many Reqs`：插件对 403/429 做三次退避重试，仍失败时如实降级并给出网页线索。

## 目录

| 文件 | 内容 |
| --- | --- |
| `index.js` | 工具、系统提示、专家 / 评审团运行逻辑、会话门控与两条开关路由、`literatureSkills` 服务 |
| `client.js` | Web 客户端：输入区「古籍」开关 |
| `experts.js` | 专家与评审团数据（纯数据，便于增删） |
| `sources.js` | 数据源适配器（Crossref / OpenAlex / Wikidata / Wikisource / 网页） |
| `skills/literature-research/SKILL.md` | 研究协议 |
| `cordis.patch.yml` | 两条 Host 行：插件本体 + 技能目录 |
| `locale/*.json`、`icon.svg` | 插件管理器显示元数据 |
| `dev/*-smoke.mjs` | 上述四个离线测试 |

## 收录到插件市场

dsh-market 的目录来自 curated registry，收录方式是向 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一个 PR，新增 `data/plugins/yujh129__dsh-literature-agents.yml`。仓库需公开、有 `dsh.bundle`、创建满 24 小时并带 topic `dsh-plugin`；条目只需 `url`、`name`、`category`、`description.{en,zh}`，一个 PR 最多三条。合并后站点与 npm 目录包由 CI 重建，客户端通常一天内可见。

## 许可

[MIT](LICENSE) © 2026 yujh129

## English

`dsh-literature-agents` gives DeepSeek Harness a literature and classical-Chinese research kit: **9 tools** (scholarly paper search, scholar biographies from Wikidata, Chinese Wikisource full-text retrieval, grounded translation, citation verification, expert summoning, review panels, expert roster), **11 specialist subagents** across 5 domains, **3 parallel review panels**, a bundled research-protocol skill, and a composer switch that gates the whole kit per conversation.

- **Install:** `dsh plugin --profile web add github:yujh129/dsh-literature-agents` (DSH >= 0.2.1-rc.2, declared via `engines.dsh`).
- **Compatibility:** developed on 0.2.1-rc.2, verified on 0.2.2-rc.5 (the 0.2.2 removal of `ctx.subagents.list()` is handled by probing `ctx.subagents.getProvider()`); declared range `>=0.2.1-rc.2 <0.4.0-0`.
- **Per-conversation switch:** the composer toggle registers at `conversation.input.left`, stores state per session in `~/.dsh/dsh-literature-agents/toggles.json`, and is on by default; disabling it hides all nine tools for that session only.
- **Honest sources:** every retrieval prints `数据源：…` with a check mark or a failure reason; nothing is fabricated when a source is down.
- **Tests:** `npm test` runs four offline smoke suites (`dev/manifest-smoke.mjs`, `dev/register-smoke.mjs`, `dev/client-smoke.mjs`).
- **License:** MIT.
