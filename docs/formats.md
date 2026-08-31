# 支持的聊天导出格式

所有解析在本机完成，不需要联网。导入前请先看「解析预览」确认识别结果。

## 微信

### 留痕 MemoTrace / WeChatMsg（推荐）

| 格式 | 识别字段 | 状态 |
|---|---|---|
| JSON | `sender` / `nick` / `msg` / `CreateTime`(秒) / `CreateTimeStr` / `is_sender`(0=对方,1=本人) / `type_name` | ✅ 完整支持，`is_sender` 自动映射本人标记 |
| CSV | 表头含 `StrContent` / `SenderName` / `CreateTime` / `is_sender` 等（大小写/下划线不敏感） | ✅ 完整支持 |
| TXT | 时间戳行文本 | ✅ 按通用 TXT 解析 |

工具地址：<https://github.com/LC044/MemoTrace>

### 微信合并转发复制文本

在微信中多选消息 → 合并转发 → 打开后全选复制，粘贴形如：

```
她的昵称
12:05
今天有点累，回头说

我的昵称
12:07
好的你休息
```

✅ 已支持（块状解析：昵称行 + 纯时间行 + 内容行，直到下一个块）。建议配合「我的昵称」字段标记本人。

## QQ

### 常见导出工具的 TXT

```
2024-01-01 12:00:00 她的昵称(12345)
今天有点累
回头再说

2024-01-01 12:05:00 我的昵称(67890)
好的你休息
```

✅ 已支持：时间戳行开块、多行正文、自动剥离 `(QQ号)` 后缀。文件为 ANSI/GBK 编码时自动检测并转码。

## 通用格式

| 格式 | 说明 |
|---|---|
| JSON 数组 / 含 messages·items·data 键的对象 | 自动嗅探字段：时间（`timestamp`/`time`/`datetime`/`ts`…）、发送者（`sender`/`nick`/`talker`/`from`…）、内容（`msg`/`content`/`text`/`message`…）、本人标记（`is_sender`/`isSelf`…），大小写与下划线不敏感 |
| JSONL（每行一个 JSON） | 逐行解析 |
| CSV | 首行表头按语义匹配列 |
| 时间戳格式 | 10 位秒 / 13 位毫秒 / `2024-01-01 12:00:00` / `2024/1/1 12:00` / `2024年1月1日 9:30` / 纯 `12:30` |
| 自由粘贴 | `昵称：内容` 单行格式 |

## 已知限制

- 单文件上限 20MB；单次导入上限 20000 条（超出部分显式提示截断）。
- 图片/语音/表情包消息以 `[图片]` 等占位符保留（文本分析主要依据文字内容）。
- 撤回消息、引用回复等特殊消息类型按原始文本处理。
- 识别率依赖原始导出质量；导入后请在「原话库」抽查，异常条目可单条删除。

## 国际平台（对齐 ChatLab，v1.2.2 起支持）

| 平台 | 格式 | 说明 |
|---|---|---|
| WhatsApp | 官方导出 TXT | 安卓 `d/m/yy, HH:MM - 昵称: 内容` 与 iOS `[d/m/yy, HH:MM:SS] 昵称: 内容`；day-first 优先、AM/PM 与 上午/下午 均可、多行消息合并、群系统事件跳过 |
| LINE | 官方导出 TXT | TSV（`时间 TAB 昵称 TAB 内容`）与 App 文本（昵称行+内容+时间行收尾）两种形态；`2025.03.01 Monday` 日期行归属 |
| Telegram | Desktop 导出 JSON | 单聊天（name+messages）与多聊天（chats，取消息最多一路）；text 数组聚合、service 消息跳过 |
| Discord | DiscordChatExporter JSON / CSV / TXT | JSON 需 guild+channel+messages；TXT 为 `[01-Mar-25 12:44 PM] 昵称` 行式，分页符自动剥离 |
| Instagram | 官方数据包 JSON | participants+messages（timestamp_ms、最新在前自动反转）；Latin-1 乱码迭代修复 |
| Google Chat | Takeout JSON | messages[].creator/created_date/text；中英文本地化日期 + UTC 偏移确定性解析 |
| iMessage | CSV 导出 | 含 Date/发送者/Text 列的 CSV（如 iMazing 导出），is_from_me=1 标记本人 |
