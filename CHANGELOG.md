# Changelog

所有重要变更记录在本文件。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.1.0] - 2026-08-31

### Added —— 多格式 API 接入
- **五种接入格式**：OpenAI 兼容（Chat Completions，覆盖 DeepSeek/Kimi/GLM/Qwen/OpenRouter/OneAPI 等网关）、Azure OpenAI（api-key 头 + 部署地址）、Anthropic Claude（Messages API，x-api-key + anthropic-version，system 独立传输与必填 max_tokens 正确处理）、Google Gemini（原生 generateContent，role 映射与 systemInstruction）、Ollama 本地模型（无需密钥，全程离线）
- **获取模型列表**：OpenAI 兼容 / Anthropic / Gemini / Ollama 均可一键拉取并下拉选择（Gemini 自动过滤非文本模型）；Azure 部署制明确提示
- 设置页按协议动态渲染表单（地址占位符/密钥/模型示例/说明），连接测试与错误提示按协议归一（401 密钥/404 地址模型/429 限流/超时等中文可行动提示）
- Gemini 安全拦截场景给出 finishReason 提示；适配器为纯函数架构（build/parse 可离线单测）

## [1.0.1] - 2026-08-31

第二轮对抗式审查修复（安全回归猎杀 / 产品门面 / 发布工程）。详见 [docs/round-06-second-review.md](docs/round-06-second-review.md)。

### Fixed
- **数据污染**：微信"上午/下午"时间格式解析失败与同人群连发丢消息（重写无时间戳解析器）、extractJson 多围栏取错候选、IPC 并发丢更新（人物级互斥）、撤销后闭环率 200%、卡片总量截断死代码、复盘失败永久失去报告
- **安全纪律**：红线守卫补齐卡片写入通道（claims/dynamic/访谈/目标）+ 归一化防变形绕过；删除档案失败不再静默（防"复活"）；访谈用户陈述统一以推断落库；`__proto__` 索引污染；file:// 导航全禁；claims 字段校验；API Key 密文仅主进程可写
- **发布门面**：README 安装表如实标注各平台状态、移除 404 badge、命中率口径修正（错判计入分母）、CI 加固（action SHA 锁定/最小权限/npm ci/SHA256SUMS）、API Key 加密跨平台如实描述 + 明文状态警示 + 清除入口

## [1.0.0] - 2026-08-31

首个公开发布版本。

### Added
- **人物生境档案**：本地优先的 JSON 存储（原子写入 + 启动对账 + 单实例锁）
- **生境卡**：AIRP 四层认知条目（基础信息/生活结构/人物性情/场景表达）+ 动态状态层；认识层级（事实/推断/空白）× 来源（证据/用户陈述/AI推断）× 置信度；AI 归纳初稿；注入卡片预览与导出/导入
- **聊天记录导入**：留痕 MemoTrace / WeChatMsg（JSON·CSV·TXT）、QQ 时间戳 TXT、微信合并转发复制文本、通用 JSON/JSONL/CSV/自由粘贴；GBK 自动检测；20MB/20000 条上限与显式截断提示
- **24问访谈**：人物观察版题库、抽象回答 AI 追问、中途小结、最终整合、勾选写入（用户陈述·待验证）、Q24 → 孪生防误读护栏
- **演练沙盒**：场景模板与自定义；情境设定/演练目标分离；数字孪生多轮对话；红线拦截；复盘报告（六观察指标 + 沟通复盘 + 验证清单）
- **校准闭环**：预测单冻结 → 现实回流 → 七类差异归因 → 可撤销的卡片最小修正；直录现实反应（无预测单）；Top1/Top2 命中率与闭环完成率统计
- **话题雷达**：空白 + 用户陈述待验证 + 访谈待确认 → 现实求证话题
- **红线守卫**：操控类请求三通道硬过滤；临床标签禁令；导入知情提示；API Key DPAPI 加密
- **跨平台打包**：Windows NSIS/zip（本地构建，已发布）；macOS dmg（x64/arm64）与 Linux AppImage/deb 的 CI 构建已配置，待启用（见 docs/enable-ci.md）
- **演示模式**：离线 mock provider，无 Key 可体验全流程
- 测试 24 项（纯 Node，无 GUI 依赖）

### Security
- contextIsolation / CSP / IPC UUID 校验与路径穿越防御 / 窗口导航拦截 / 提示注入防御（素材=数据非指令；无溯源不得为事实）
- API Key safeStorage(DPAPI) 加密存储，不回传渲染层

详见 [docs/round-03-adversarial-review.md](docs/round-03-adversarial-review.md)。

## [0.2.1] - 2026-08-31

对抗式审查修复（三路审查：安全隐私 / 正确性 / 方法论保真）。
修复 P0×2（24问访谈死锁、隐私文案与数据流矛盾）、P1×12（提示注入投毒链、红线场景绕过、IPC 路径穿越、微信合并转发解析、乐观更新回滚、归因自动改卡等）、P2 若干。

## [0.2.0] - 2026-08-31

- 生境卡导入（格式标识校验 + 逐条净化）；导入仅迁移认知结构，不携带原始证据

## [0.1.0-mvp] - 2026-08-31

最小可用版本：档案、生境卡、证据库、导入、演练+复盘、校准闭环、24问访谈、话题雷达、设置。
