# dsh-literature-agents

文学与古典文献领域专家插件，面向 DeepSeek Harness `0.2.1-rc.2`。

一个 Host bundle + 一个 Web client 模块：**9 个文献工具**、**11 位文史专家子代理**、**3 个评审团**，
外加输入区的一个「古籍」开关，用来按对话启停整套能力。

运行逻辑与入口位置参考 `@michengai/dsh-agency-agents`（计算机领域精简替代版 `dsh-agency-agents-cs`）：
一条 `cordis.patch.yml` insert 行、模型侧工具 + 常驻系统提示 + 经 `ctx.subagents.startActivation()` 运行的专家子代理。

## 能力（9 个工具）

| 能力 | 工具 | 数据源 |
| --- | --- | --- |
| 论文检索 | `search_scholar_papers` | Crossref、OpenAlex，网页搜索兜底 |
| 学人生平 | `get_scholar_biography` | Wikidata（属性级溯源）+ OpenAlex 著作 |
| 古籍检索 | `search_classic_texts` | 中文维基文库全文检索 |
| 古籍阅读 | `get_classic_text` | 中文维基文库页面正文 |
| 古籍翻译 | `translate_classic` | 先检索平行文本/旧注，再由翻译专家今译/英译 |
| 引用核验 | `verify_citation` | Crossref DOI、题名相似度 |
| 专家召唤 | `summon_literature_expert` | 11 位文史专家子代理 |
| 评审团 | `run_literature_panel` | 3 个并行评审团 |
| 专家名册 | `list_literature_experts` | 列出全部专家、领域与评审团 |

每个检索类输出都带一行 `数据源：… ✓/✗（原因）`，源失败时如实降级，不补造结果。

## 专家（11 位，5 个领域）

- 史学与人物：史学史专家 `historiographer`、学人行实考据专家 `biographer`
- 文献考据：校勘学家 `textual-critic`、目录版本学家 `bibliographer`、训诂学家 `philologist`
- 古籍翻译：古籍翻译家 `classics-translator`、注疏专家 `scholia-expert`
- 文学研究：文学批评家 `literary-critic`、比较文学学者 `comparatist`
- 数字人文与核验：数字人文研究者 `digital-humanist`、学术核验员 `citation-auditor`

## 评审团（3 个）

- 古籍考据评审团 `classics-research-panel`：目录 + 校勘 + 训诂 + 注疏
- 文学研究评审团 `literature-review-panel`：史学史 + 文学批评 + 比较文学 + 引用核验
- 古籍翻译审校团 `translation-review-panel`：译文 + 旧注 + 训诂 + 引用

评审团只返回成员独立意见；主会话负责核验证据、去重、按严重级别汇总后交付。

## 技能

`skills/literature-research/SKILL.md` 由第二个 Host 行（`@deepseek-ai/dsh-skill-filesystem`）挂载，
提供分层检索、事实纪律、生平考据、古籍阅读、翻译规范与引用核验清单。

`@deepseek-ai/dsh-skill-filesystem` 由 `@deepseek-ai/dsh-base` 提供（每个 profile 的第一个 bundle），
插件不 import 它，只在 patch 里按模块名挂载，因此不声明 `peerDependencies`——声明会让 pnpm 在 profile 里
另装一份旧版本，反而遮蔽宿主自带的那份。

## 安装

### 从插件市场（dsh-market）

在 dsh-market 中搜索 **Literature & Classics Agents** 安装。安装目标就是本仓库：

```text
dsh plugin add github:yujh129/dsh-literature-agents
```

> 桌面版默认不会把 `dsh` 加进 PATH。命令行提示「无法将“dsh”项识别为 cmdlet」时，改用完整路径
> `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`，或把该 `bin` 目录加进 PATH，或让 agent 用下面的
> `plugin_manager` 方式安装。

也可以让 agent 在当前会话里调用：

```text
plugin_manager install_bundle target="github:yujh129/dsh-literature-agents"
```

安装会自动加入 profile 的 `dsh.profile.bundles` 并热装载；若曾被停用，再启用一次：

```text
plugin_manager set_bundle target="dsh-literature-agents" enabled=true
```

生效后新会话或下一模型步即可看到 9 个工具、技能与输入区「古籍」开关。

### 本地开发（源码目录）

```text
plugin_manager install_bundle target="<本仓库的绝对路径>"
```

### 卸载

```text
plugin_manager remove_bundle target="dsh-literature-agents"
```

## 输入区开关

输入框左侧工具行有一个「古籍」开关（`conversation.input.left`，id `literature-toggle`）：

- **开（品牌色圆点）**：本对话可调用 9 个文献工具，系统提示中含专家引导。
- **关（灰色圆点）**：`tools.restrict({deny})` 在该会话的 Agent 上下文里隐藏全部 9 个工具，
  并移除专家引导段；其他对话不受影响。技能仍在目录中，但没有工具可调用。
- 状态按 `SessionId` 保存在 `~/.dsh/dsh-literature-agents/toggles.json`（`DSH_HOME` 优先），
  重启后仍在；新对话默认开启。
- 切换立即作用于该会话的 Agent；若某一轮正在生成，从下一模型步开始生效。
- 这是**用户专属**操作：没有对应的 Agent 工具，模型无法自行打开或关闭。

客户端模块是 `client.js`，由本包 `package.json` 的 `dsh.client` 声明注入 Web 启动图；
状态、门控与两个路由（`GET /plugins/dsh-literature-agents/state`、
`POST /plugins/dsh-literature-agents/toggle`）都在 `index.js`。

## 配置

```yaml
- id: literature-agents
  name: dsh-literature-agents
  config:
    provider: spawn   # 子代理 provider；默认 spawn，缺失时回退到任一非 fork provider
    maxDepth: 1       # 召唤出的专家最多再委派一层；provider 不支持时自动省略
```

## 目录

- `index.js`：工具、系统提示、专家/评审团运行逻辑、会话门控与两个开关路由、`literatureSkills` 服务
- `client.js`：Web 客户端，输入区「古籍」开关
- `experts.js`：专家与评审团数据（纯数据，便于增删）
- `sources.js`：数据源适配器（Crossref / OpenAlex / Wikidata / Wikisource / 网页）
- `skills/literature-research/SKILL.md`：研究协议
- `cordis.patch.yml`：两个 Host 行
- `locale/*.json`、`icon.svg`：插件管理器显示元数据

## 网络依赖

- 必需：Crossref、OpenAlex、Wikidata、中文维基文库。
- 可选：宿主网页搜索服务（`dsh-free-search` 等），仅作兜底与线索。
- 已知不可达（本机实测）：zh.wikipedia.org、ctext.org、Semantic Scholar、Gutendex；这些源不参与主链路，只在输出中作为引用地址出现。
- Wikidata 的 `www.wikidata.org` 接口在共享 IP 上常见 `403 Too Many Reqs`；插件对 403/429 做三次退避重试，仍失败时如实降级并给出网页线索，不补造数据。

## 适配要点（改代码前必读）

- **工具参数必须编译成 JSON Schema**：宿主 `ctx.tools.register()` 原样保存 `parameters`，由模型适配器
  直接作为 `input_schema` 发送；它不会执行 `defineTool()` 里的
  `parameterSchemaSpecToJsonSchema()`。插件仍按 property-map 写法维护参数（便于增删），
  但注册前统一经本地 `parameterSchema()` 编译为
  `{type:"object", properties, required}`——与宿主编译结果逐字段一致。
  跳过这一步会让工具以裸属性表进入请求，DeepSeek API 直接返回 400
  `Invalid schema for function ...`。
- 该编译在插件内完成，不依赖解析宿主安装目录里的 `@deepseek-ai/dsh-tools`，
  因此在不存在 `node_modules` 的目录安装、或以 `link:` 方式安装时都可工作。
- **客户端模块的 `id` 必须等于包名**（`window.__ModuleLoader__.load({ id: 'dsh-literature-agents' })`）：
  宿主按包名把 `dsh.client` 声明合进 Web 启动图，id 不一致模块不会被找到。
- 专家子代理经 `ctx.subagents.startActivation()` 启动；`maxDepth` 仅在 provider 声明
  `capabilities.depthLimit` 时传入，其余情况自动省略。

## 开发自检

改完代码先跑这两个离线冒烟测试（不联网、不写状态、不装依赖）：

```text
npm run smoke          # 两个都跑
npm run smoke:host     # index.js：9 个工具的参数必须是合法 JSON Schema，2 条开关路由已注册
npm run smoke:client   # client.js：模块 id 等于包名，输入区只注册一个入口
```

`dev/` 不在 `files` 里，不会被发布出去。

## 发布到插件市场（维护者）

dsh-market 从 curated registry 读取目录，收录方式是向
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提一个 PR，新增 `data/plugins/yujh129__dsh-literature-agents.yml`。
仓库需要满足：公开、有 `dsh.bundle`、创建满 24 小时、带 GitHub topic `dsh-plugin`。
条目只需 `url`、`name`、`category`、`description.{en,zh}` 四个字段，一个 PR 最多三条。

## 许可

MIT，见 [LICENSE](LICENSE)。

## English summary

`dsh-literature-agents` gives DeepSeek Harness a literature and classical-Chinese research kit:
9 tools (scholarly paper search, scholar biographies from Wikidata, Chinese Wikisource full-text
retrieval, grounded translation, citation verification), 11 specialist subagents across 5 domains,
3 parallel review panels, a bundled research-protocol skill, and a composer switch that gates the
whole kit per conversation. Every retrieval prints its data source and degrades honestly instead of
filling gaps.
