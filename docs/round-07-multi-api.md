# Round 07 · 多格式 API 接入（v1.1.0）

日期：2026-08-31

## 需求

支持各种格式的 API 接入，而不只 OpenAI 兼容一种。

## 实现：适配器架构

`llm.js` 重写为多协议适配器（每个适配器导出纯函数 `build()/parse()/modelsUrl()/parseModels()`，可离线单测）：

| 协议 | 端点 | 认证 | 关键差异处理 |
|---|---|---|---|
| `openai`（Chat Completions） | `{base}/v1/chat/completions`（自动补全，容忍尾斜杠/query/Gemini 风格 `/openai` 结尾） | `Authorization: Bearer` | 覆盖 DeepSeek/Kimi/GLM/Qwen/OpenRouter/OneAPI 等全部中转网关 |
| `azure` | 用户填部署完整地址（含 api-version）原样使用 | `api-key` 头 | body 不发 model（部署名在地址中）；模型列表不适用并明确提示 |
| `anthropic` | `{base}/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | system 提示词独立传输（splitSystem）；`max_tokens` 必填（默认 2048，设置页可调） |
| `gemini` | `{base}/v1beta/models/{model}:generateContent` | `x-goog-api-key` 头 | role 映射 assistant→model；systemInstruction；安全拦截时给出 finishReason 提示 |
| `ollama` | `{base}/api/chat` | 无需密钥 | 本地完全离线，与"本地优先"红线最契合 |
| `mock` | 离线演示 | — | 不变 |

## 交互

- 设置页按协议动态渲染（地址占位符、密钥、模型示例、说明）
- **获取模型列表**：openai(`/models`)、anthropic(`/v1/models`)、gemini(`/v1beta/models`，过滤非 generateContent 模型)、ollama(`/api/tags`) → datalist 下拉选择
- 连接测试走统一 `chat()`，各协议真实打一次请求
- 错误提示按协议归一：从各协议错误体提取 message，401/404/429/413/超时全部映射为中文可行动提示
- 侧边栏模式徽章显示当前协议与模型

## 安全

- API Key 加密机制（safeStorage）对所有协议生效；`apiKeyEnc` 仍仅主进程可写
- 各协议 Key 仅进各自协议头，不写 URL（Gemini 用头而非 query 参数，避免 Key 进日志/代理日志）

## 验证

- 测试 28 → **35 个全部通过**：每个适配器的 URL/头/体结构断言（anthropic system 独立、azure 无 model 字段、gemini role 映射、ollama 无 Authorization 等）+ 响应解析 + 模型列表解析 + 非法 provider 报错
- 全部文件语法检查通过

## 版本

v1.1.0
