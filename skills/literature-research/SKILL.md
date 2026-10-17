---
name: literature-research
description: >
  Research protocol for literature, historiography, and classical Chinese
  texts in DeepSeek Harness: source-tiered retrieval (Crossref / OpenAlex /
  Wikidata / Chinese Wikisource / labelled web fallback), citation verification
  before any claim is repeated, biography lookup with property-level evidence,
  classical-text reading from primary sources, and grounded translation into
  modern Chinese or English with exegesis and notes. Use whenever a request
  involves 论文检索、学术史、生平/年谱、古籍原文、出处考证、引文核验、
  今译、英译、注疏、版本校勘、目录版本、文学文本分析、比较文学, or when a
  citation must be checked before it is used.
version: 1.0.0
---

# 文学与古典文献研究协议

本技能是 `dsh-literature-agents` 插件的工作手册。工具负责取真实数据，技能负责规定“怎么用这些数据下结论”。

## 1. 何时加载

出现下列任一情形时，先加载本技能，再动笔：

- 需要引用论文、专著、古籍或学术观点；
- 需要回答某位学者/历史人物的生平、著述、交游；
- 需要解释、断句、翻译一段古籍原文；
- 需要判断一条参考文献是否真实存在；
- 需要评审论文、书稿、译文的证据与规范。

## 2. 分层检索，逐层降级

| 层级 | 数据源 | 适用 | 可信度 |
| --- | --- | --- | --- |
| 1 | Crossref、OpenAlex | 论文题录、DOI、刊名、年份 | 高（结构化元数据） |
| 2 | Wikidata | 生卒、籍贯、职业、教育、任职、代表作 | 中高（声明可溯源到属性，但不保证完整） |
| 3 | 中文维基文库 zh.wikisource.org | 古籍全文、作者页 | 中（有校本差异与录入错误） |
| 4 | 宿主网页搜索 | 线索、书评、馆藏页 | 低（只作线索，必须再核） |

规则：

1. 能落到第 1–3 层就不要只写第 4 层；第 4 层结果必须标注“未核验”。
2. 工具返回的 `数据源：… ✓/✗` 行就是降级记录。源失败时如实转述，不要用记忆补足。
3. 中文作者名在 Crossref/OpenAlex 常以拼音收录，检索时同时给中文名与拼音/英文名。
4. 古籍检索优先用篇名或原文连续字串；命中的是页面，不是“结论”，必须 `get_classic_text` 读原文。

## 3. 事实纪律

- 每个具体事实后面都能追到：DOI / URL / Wikidata 属性号 / 卷次页码。
- 区分四种表述：**已核实**（有记录）、**有争议**（并列出说）、**推测**（说明依据与缺口）、**未检得**（说明查过哪些源）。禁止把推测写成断言。
- 不写“众所周知”“学界普遍认为”而不给出至少一个可查论著。
- 引用格式（中文）：作者：《篇名》，《刊名》年份第 X 期，第 X–X 页。DOI: …；专著：作者：《书名》，出版地：出版社，年份，第 X 页。
- 引用格式（英文）：Author, "Title", Journal vol, no. x (year): pages. DOI: …

## 4. 学人生平考据流程

1. `get_scholar_biography` 取 Wikidata 字段（生卒 P569/P570、籍贯 P19/P20、职业 P106、领域 P101、教育 P69、任职 P108、代表作 P800）。
2. 同名候选多于一个时，用 `qid` 精确指定，不要默认第一个。
3. Wikidata 只作骨架；正式文稿需补年谱、传记、墓志或研究专著，并按“资料层级”说明采信理由。
4. 生卒只知年不知月日，写“约”或“待考”；异说并列。
5. 著作列表来自 OpenAlex 自动匹配，可能不是同一人——引用前核对作者身份。

## 5. 古籍检索与阅读

1. `search_classic_texts` 定位页面；必要时换书名/篇名/原文串重试。
2. `get_classic_text` 读原文，注意：录入讹字、异体字、分段与标点均为后人所加。
3. 引用原文时注明：书名、卷次/篇名、版本或数据库（例：维基文库《史記/卷007》），并说明标点为整理者所加。
4. 版本问题（底本、异文、刊刻）交 `bibliographer` / `textual-critic`；字词训释交 `philologist`；旧注分歧交 `scholia-expert`。

## 6. 翻译规范

默认产出：题解 → 原文分段 → 今译 → 注释 → 存疑。

- 先释后译：逐句落实词义、句读、指代、省略成分，再翻译。
- 今译用现代汉语书面语，不文白夹杂；不增删信息；专名首见加注。
- 典故、制度、器物注明出处或简要解释；异文与歧解在注中交代。
- 英译用学术体例：专名拼音＋汉字＋释义，术语前后一致，句法以可读为先。
- 疑难字句给“一说……”，并标存疑；不硬译。
- 翻译前必须检索平行文本/旧注（`translate_classic` 已内置），检索不到就明说“缺外部依据”。

## 7. 引用核验清单

对每一条要写进正文的文献：

1. 拆要素：作者、篇名、刊名/书名、年、卷、期、页、DOI/ISBN。
2. `verify_citation` 跑一遍；有 DOI 必须解析 DOI。
3. 相似度 ≥75% 只算“可能对应”，仍要人工比对作者与卷期；<55% 视为未找到。
4. 中文文献未被 Crossref/OpenAlex 收录很常见，需转查国家图书馆 OPAC、读秀、CNKI 篇名库。
5. 判定为“疑似伪造”的条件：作者与题名错配、期刊卷期不存在、年份与卷期矛盾、把学位论文当期刊论文。

## 8. 输出模板

```text
结论：（3 句内）

依据：
1. ……（出处：DOI/URL/卷页）
2. ……

分歧与存疑：
- ……（异说 A vs B，采信理由）

未核实项：
- ……（查过哪些源、下一步怎么查）
```

## 9. 常见错误

- 把网页搜索摘要当论文元数据；
- 把 Wikidata 当作完整生平（它常常缺项，且可能有异说）；
- 用维基文库的录入文本直接断言“原文如此”（应说明版本与录入差异）；
- 翻译时用现代概念替换古代范畴而不加说明；
- 引文只写“参见某书”而不给卷页；
- 为了让答案完整而补一个看起来合理的 DOI。
