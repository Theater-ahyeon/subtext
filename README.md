# 生境沙盒 · Habitat Sandbox

> 基于 **AIRP 人物生境写法** 的社交演练沙盒：为一个真实的人建立"生境档案"（数字孪生），在她身上彩排重要对话，用她的真实反应校准认知 —— **本地优先，只辅助理解与表达，不提供操控**。

[![Build & Release](https://github.com/Theater-ahyeon/habitat-sandbox/actions/workflows/release.yml/badge.svg)](../../actions)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 这是什么

面对一场重要的对话（道歉、表白、化解冷战、谈薪、摊牌），你有没有想过"如果能先排练一遍就好了"？

**生境沙盒**做的事：

1. **建立她的生境档案** —— 导入你们的聊天记录（或手动存证 / 通过 24 问访谈口述），AI 按"人物生境写法"归纳出一份**四层生境卡**：基础信息（她是谁）、生活结构（她长期能接触的现实）、人物性情（她怎样理解事情）、场景表达（她怎样开口与行动）。
2. **数字孪生演练** —— 选一个场景，AI 扮演她与你对话。卡片是"最小生成条件"而非台词库：她可以沉默、追问、拒绝、继续过自己的日子。
3. **预测-校准闭环** —— 演练结束前冻结一份**预测单**（2~4 个带概率的心理假设）；之后把她在现实中的真实反应粘贴回来，AI 对照**差异归因**（命中/事实错/材料缺/性情错/表达偏），并对生境卡做**可撤销的最小修正**。用得越久，这个"她"越准。
4. **话题雷达** —— 档案里的"空白"与"待验证"变成下次真实聊天时可以自然求证的话题。

**核心理念（来自人物生境写法）**：不为角色预写答案，只建立让她能在陌生情境中继续生活的最小生成条件；写倾向、不写唯一答案；不知道的留白，不脑补。

## 安装

从 [Releases](../../releases) 下载对应系统安装包（由 CI 在三大系统上构建）：

| 系统 | 文件 | 说明 |
|---|---|---|
| Windows | `Habitat Sandbox Setup <版本>.exe` | NSIS 安装向导，可选便携版 `*.zip` |
| macOS | `Habitat Sandbox-<版本>.dmg` | Intel 与 Apple Silicon（x64 + arm64） |
| Linux | `Habitat Sandbox-<版本>.AppImage` / `*.deb` | AppImage 免安装，deb 适用于 Debian/Ubuntu |

> 安装包未做代码签名（个人开源项目），Windows SmartScreen / macOS Gatekeeper 可能提示，选择"仍要运行"即可。

**首次使用**：应用默认运行在**演示模式**（离线内置样例数据，全流程可体验）。要接真实模型，到「设置」切换为 OpenAI 兼容接口，填入任意兼容网关的地址 / Key / 模型名即可。

## 功能总览

```
导入素材 ──→ 证据库 ──→ AI 归纳 ──→ 生境卡（四层 + 动态状态）
  ↑                                │
  │                                ├─→ 演练沙盒（数字孪生 + 复盘报告）
24问访谈（冷启动口述）──────────────┤
  │                                ├─→ 校准闭环（预测冻结 → 现实回流 → 差异归因 → 卡片更新）
  └──→ 空白/待验证 ──→ 话题雷达 ←───┘
```

| 模块 | 说明 |
|---|---|
| **导入** | 支持 [留痕 MemoTrace](https://github.com/LC044/MemoTrace) / WeChatMsg 的 JSON·CSV·TXT、QQ 导出工具的时间戳 TXT、微信合并转发复制文本、通用 JSON/JSONL、自由粘贴。解析完全在本机，支持"我的昵称"标记本人、GBK 自动检测 |
| **证据库** | 所有推断的唯一事实来源。只存证不评论；每条证据有编号（E#），AI 的归纳必须引用编号 |
| **生境卡** | 四层认知条目，每条带认识层级（事实/推断/空白）、来源（证据/用户陈述/AI推断）、置信度；易过期信息只进"动态状态"层；AI 实际收到的最小卡片可预览、可导出 JSON |
| **24问访谈** | 人物观察版的结构化口述访谈：核心特质收敛 → 分化与反向 → 信念分层 → 情绪ABC → 循环与决策。抽象回答会被追问"具体会怎么做"；跳过=暂未确定；最终整合可勾选写入生境卡（用户陈述·待验证），Q24 直接成为孪生的防误读护栏 |
| **演练** | 场景模板（日常/约会/冷战/道歉/重要谈话/请求）或自定义。分"情境设定"（她可感知）与"演练目标"（仅复盘可见，她不知道这是演练）。结束生成复盘报告：六个观察指标（连续性/变化性/迁移/独立性/时间连续/成长）+ 你的沟通复盘 + 下轮建议 + 现实验证清单 |
| **校准闭环** | 预测单冻结 → 现实反应回流（原话优先，自动存证）→ 差异归因 → 卡片最小修正（可一键撤销）。统计：Top1/Top2 命中率、闭环完成率、待回流数 |
| **话题雷达** | 生境卡空白 + 用户陈述待验证 + 访谈待确认 → "下次可以了解她什么" |

## 方法论映射（AIRP 人物生境写法 → 产品纪律）

| 方法论原则 | 产品实现 |
|---|---|
| 生境卡=最小生成条件，不是全量画像 | 空白层不进卡；置信度 <0.3 不进卡；每层 ≤8 条、总量 ≤28；可预览注入内容 |
| 静态人设与动态事实分离 | 易过期信息只进"动态状态"，可"翻篇"；防止关系倒退/情绪过期 |
| 写倾向，不写唯一答案 | 归纳与假设强制倾向措辞（往往/容易/更愿意），禁"永远/绝不" |
| 标签必须附带具体含义 | 追问引擎：抽象标签 →"具体会做什么"→"为什么这是她的" |
| 推断可溯源、不脑补 | 条目必须挂证据编号 / 用户陈述 / AI推断；无溯源不得为"事实" |
| 示例教表面文风（防复读/旁白/补造） | 孪生禁内心独白；卡内标注[事实]/[推断]区分可靠度；防误读护栏 |
| 六个观察指标 | 复盘报告的固定评估框架 |
| 心理分析=行为推测，决策权在用户 | 多假设+概率+验证方式；归因改卡可撤销；"推断不是真相"贯穿文案 |

详见 [docs/methodology.md](docs/methodology.md)。

## 隐私与红线

- **本地优先**：档案、证据、演练、访谈全部数据只存在本机 `%APPDATA%/habitat-sandbox/habitat-data/`（macOS/Linux 在各自 userData 目录），删除档案即全部删除。
- **如实告知**：配置在线模型后，生境卡与相关对话文本会发送给你所配置的模型服务商处理，请自行选择可信服务商。API Key 经系统级加密（Windows DPAPI）保存，不明文落盘。
- **知情提示**：导入第三方聊天记录时应用内明确提示——仅用于自我理解与沟通练习，勿导入你无权处理的对话。
- **拒绝操控**：引擎级硬过滤操控/打压/煤气灯类请求（场景、消息、反馈三条通道），并提供"诚实表达自己需求"的替代方向；禁止输出临床诊断标签。
- **心理分析不是诊断**：所有心理输出都是行为推测 + 置信度 + 验证方式。它帮你理解与表达，不定义她是"什么病"。

## 开发

```bash
git clone https://github.com/Theater-ahyeon/habitat-sandbox.git
cd habitat-sandbox
npm install          # npmmirror 镜像配置见 .npmrc
npm start            # 启动应用（演示模式）
npm test             # 单元测试（24 个，无需 Electron/GUI/Key）
npm run dist         # 本地构建 Windows 安装包（nsis + zip）
```

技术栈：Electron 33 · 原生 HTML/CSS/JS（无构建步骤）· JSON 本地存储（原子写入 + 启动对账）· OpenAI 兼容 API（含离线 mock）。业务核心（store/parser/llm/prompts/pipeline）与 Electron 解耦，可在纯 Node 环境测试。

### 项目结构

```
src/
  main/          # 主进程（无 Electron 依赖的纯 Node 模块 + main.js IPC 编排）
    store.js     #   本地存储：JSON 原子写入、索引对账、统计
    parser.js    #   聊天记录导入解析（JSON/CSV/TXT/微信合并转发）
    llm.js       #   LLM Provider（OpenAI 兼容 + 离线 mock）与 JSON 提取
    prompts.js   #   全部提示词：生境卡编译、孪生、归纳、复盘、假设、归因、24问、红线
    pipeline.js  #   业务流：归纳→演练→预测→回流→归因→撤销、访谈
    main.js      #   Electron 窗口 + IPC（安全基线在此）
  preload.js     # contextBridge IPC 白名单暴露
  renderer/      # 无构建 SPA（index.html + css + js）
tests/run.js     # 单元测试（node tests/run.js）
docs/            # 每轮开发进度文档 + 方法论 + 格式说明
build/           # 图标与生成脚本
```

### 安全基线

contextIsolation + 无 nodeIntegration + CSP（script-src 'self'）· IPC id 严格校验（UUID 正则 + 路径穿越防御）· 渲染层全量 HTML 转义 · 窗口导航/弹窗拦截 · 单实例锁 · 提示注入防御（素材=数据非指令 + 无溯源不得为事实）。详见 [docs/round-03-adversarial-review.md](docs/round-03-adversarial-review.md)。

## 路线图

- [ ] SQLite 存储后端（存储层已接口化）
- [ ] 风格示例轮换池（防场景表达层被固定模仿）
- [ ] 归因建议"确认后应用"模式
- [ ] 代码签名（Windows 证书 / macOS notarization）
- [ ] 多人物对比视图、关系时间线
- [ ] verdict 两维化（结果 × 归因层次）

## 文档索引

- [docs/methodology.md](docs/methodology.md) —— 方法论与产品映射详解
- [docs/formats.md](docs/formats.md) —— 支持的聊天导出格式对照
- [docs/round-00-setup.md](docs/round-00-setup.md) → [round-05-release.md](docs/round-05-release.md) —— 每轮开发进度
- [docs/round-03-adversarial-review.md](docs/round-03-adversarial-review.md) —— 对抗式审查与第一性原理修复
- [docs/enable-ci.md](docs/enable-ci.md) —— 启用三平台 CI 构建（三条命令）
- [CHANGELOG.md](CHANGELOG.md)

## 许可

MIT © 2026 Theater-ahyeon
