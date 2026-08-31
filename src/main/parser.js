'use strict';
/**
 * 聊天记录导入解析器。
 * 目标兼容 GitHub 常见导出工具的产物：
 *  - 留痕 MemoTrace / WeChatMsg（微信）：JSON（含 is_sender/talker/msg/CreateTime）、CSV、TXT
 *  - QQ 导出工具常见 TXT（"2024-01-01 12:00:00 昵称(QQ号)\n内容"）
 *  - 任意 OpenAI 风格 JSON 数组 / JSONL / 通用对象数组
 *  - 纯文本粘贴（时间戳行 / "昵称：内容" 行）
 * 全部归一化为 { ts, sender, text, isSelf, meta } 并尽力排序。
 */

const TIME_KEYS = ['createtime', 'createtimestr', 'timestamp', 'time', 'datetime', 'sendtime', 'sendtime_str', 'date', 'ts', 'created_date'];
const SENDER_KEYS = ['sender', 'sendername', 'sender_name', 'senderremark', 'nick', 'nickname', 'talker', 'talkername', 'user', 'from', 'name', 'senderwxid', 'author', 'creator'];
const CONTENT_KEYS = ['msg', 'message', 'content', 'text', 'strcontent', 'msgcontent', 'body'];
const SELF_KEYS = ['is_sender', 'issender', 'isself', 'self', 'isme', 'is_send', 'is_from_me'];

function pickField(obj, keys) {
  const lower = Object.create(null); // 防原型污染：__proto__ 键退化为普通自有键
  for (const k of Object.keys(obj)) lower[k.toLowerCase().replace(/[_\s-]/g, '')] = obj[k];
  for (const key of keys) {
    const kk = key.replace(/[_\s-]/g, '');
    if (Object.hasOwn(lower, kk) && lower[kk] !== undefined && lower[kk] !== null && lower[kk] !== '') return lower[kk];
  }
  return undefined;
}

function normTs(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') {
    if (v > 1e12) return new Date(v).toISOString();
    if (v > 1e9) return new Date(v * 1000).toISOString();
    return String(v);
  }
  const s = String(v).trim();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  // 2024-1-1 12:00:00 / 2024/01/01 12:00 / 2024年1月1日 12:00
  const m = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日]?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se || '00').padStart(2, '0')}`;
  }
  const onlyTime = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (onlyTime) return onlyTime[0];
  const parsed = Date.parse(s);
  return isNaN(parsed) ? s : new Date(parsed).toISOString();
}

function normItem(item) {
  if (typeof item === 'string') {
    return { ts: '', sender: '', text: item.trim(), isSelf: null, meta: {} };
  }
  if (typeof item !== 'object' || item === null) return null;
  let content = pickField(item, CONTENT_KEYS);
  if (content && typeof content === 'object') {
    content = pickField(content, CONTENT_KEYS) || JSON.stringify(content);
  }
  let typeName = pickField(item, ['type_name', 'typename', 'type', 'msgtype']);
  if (typeName && typeof typeName === 'number') typeName = String(typeName);
  let text = content == null ? '' : String(content).trim();
  if (!text && typeName && !/^(文本|text|1)$/i.test(String(typeName))) text = '[' + typeName + ']';
  if (!text) return null;
  // 语音/图片等类型即使有文本也保留标记
  if (typeName && /^(image|图片|voice|语音|video|视频|file|文件|emoji)$/i.test(String(typeName)) && !text.startsWith('[')) {
    text = '[' + typeName + '] ' + text;
  }
  let senderVal = pickField(item, SENDER_KEYS);
  if (senderVal && typeof senderVal === 'object') senderVal = senderVal.name || senderVal.email || senderVal.user || '';
  let isSelf = pickField(item, SELF_KEYS);
  if (isSelf !== undefined) isSelf = (isSelf === 1 || isSelf === true || isSelf === '1' || isSelf === 'true');
  else isSelf = null;
  return {
    ts: normTs(pickField(item, TIME_KEYS)),
    sender: String(senderVal || '').trim(),
    text,
    isSelf,
    meta: {},
  };
}

function tryParseJsonLoose(text) {
  const t = text.trim();
  // 单个 JSON / JSONL（逐行尝试）
  try { return JSON.parse(t); } catch {}
  const lines = t.split(/\r?\n/).filter(l => l.trim());
  const items = [];
  let ok = 0, bad = 0;
  for (const line of lines) {
    try { const v = JSON.parse(line.trim().replace(/,$/, '')); items.push(v); ok++; }
    catch { bad++; }
  }
  if (ok > 0 && ok >= bad) return items;
  return null;
}

function unwrapArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const key of ['messages', 'msgs', 'items', 'data', 'chat', 'records', 'list']) {
      if (Array.isArray(v[key])) return v[key];
    }
  }
  return null;
}

// ---------- CSV（支持引号内逗号/换行） ----------
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

function csvToItems(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[_\s-]/g, ''));
  const idx = (keys) => {
    for (const k of keys) {
      const kk = k.replace(/[_\s-]/g, '');
      const i = header.indexOf(kk);
      if (i !== -1) return i;
    }
    return -1;
  };
  const iT = idx(TIME_KEYS), iS = idx(SENDER_KEYS), iC = idx(CONTENT_KEYS), iSelf = idx(SELF_KEYS);
  if (iC === -1) return null;
  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const content = row[iC];
    if (!content || !content.trim()) continue;
    let isSelf = null;
    if (iSelf !== -1) { const v = row[iSelf]; isSelf = (v === '1' || v === 'true' || v === 'TRUE'); }
    items.push({
      ts: normTs(iT !== -1 ? row[iT] : ''),
      sender: iS !== -1 ? (row[iS] || '').trim() : '',
      text: content.trim(),
      isSelf,
      meta: {},
    });
  }
  return items.length ? items : null;
}

// ---------- TXT ----------
const TS_LINE = /^(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?)\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(.*)$/;
const TIME_ONLY = /^(?:上午|下午|中午|凌晨|晚上|早上|半夜|am|pm)?\s*\d{1,2}:\d{2}(?::\d{2})?$/i;

function txtToItems(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let cur = null;
  const flush = () => { if (cur && cur.text.trim()) { cur.text = cur.text.replace(/\s+$/, ''); items.push(cur); } cur = null; };
  let foundTs = false;
  for (const line of lines) {
    const m = line.match(TS_LINE);
    if (m) {
      foundTs = true;
      flush();
      let rest = m[3].trim();
      let sender = '', body = '', isSelf = null;
      // 2024-01-01 12:00:00 张三：内容  /  张三(12345)  /  张三
      const sep = rest.match(/^(.{1,40}?)[:：]\s*(.+)$/);
      if (sep) { sender = sep[1].trim(); body = sep[2].trim(); }
      else { sender = rest; body = ''; }
      sender = sender.replace(/[(（][^)）]*[)）]\s*$/, '').trim(); // 去掉 (QQ号) / (wxid)
      cur = { ts: normTs(m[1].replace(/[年月]/g, '-').replace(/[日]/g, '') + ' ' + m[2]), sender, text: body, isSelf, meta: {} };
    } else if (cur) {
      cur.text = (cur.text ? cur.text + '\n' : '') + line;
    }
  }
  flush();
  if (foundTs) return items;

  // ---- 无日期时间戳模式 ----
  // 形态A（微信合并转发复制）：昵称行 + 纯时间行 + 内容行*；同人多条时昵称可省略（仅时间行分隔）
  // 形态B：单行 "昵称：内容"
  const parsed = parseWechatFlow(lines);
  if (parsed.messages.length) {
    for (const b of parsed.messages) {
      const content = Array.isArray(b.content) ? b.content.join('\n') : b.content;
      items.push({ ts: normTs(b.time), sender: b.sender, text: String(content).replace(/\s+$/, ''), isSelf: null, meta: {} });
    }
    // skipped 只统计未被任何形态消费的非空行
    let nonEmpty = 0;
    for (const l of lines) if (l.trim()) nonEmpty++;
    parsed.stats.skipped = Math.max(0, nonEmpty - parsed.consumedNonEmpty);
    return items.filter(i => i.text);
  }
  for (const line of lines) {
    const kv = line.match(/^(.{1,32}?)[:：]\s*(.+)$/);
    if (kv && !TIME_ONLY.test(line.trim())) items.push({ ts: '', sender: kv[1].trim(), text: kv[2].trim(), isSelf: null, meta: {} });
  }
  return items;
}

/**
 * 微信合并转发形态解析（状态机）：
 * - 进入条件：存在"昵称行 + 纯时间行"对（昵称 ≤32 字、无冒号；时间支持 上午/下午 等前缀）
 * - 块内：新的纯时间行 = 同一发送者连发下一条；"昵称+时间行"对 = 换发送者
 * - 首个块之前的区域仍按 "昵称：内容" 解析（混合文档）
 * 返回 { messages: [{sender,time,content}], consumedNonEmpty, stats: {skipped} }
 */
function parseWechatFlow(lines) {
  const isNameLine = (s) => {
    const t = String(s).trim();
    return !!t && t.length <= 32 && !TIME_ONLY.test(t) && !/[:：]/.test(t) && !TS_LINE.test(t);
  };
  const nextNonEmpty = (i) => {
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    return j;
  };
  // 探测是否存在至少一个"昵称+时间"对
  let hasBlock = false;
  for (let i = 0; i < lines.length && !hasBlock; i++) {
    if (!isNameLine(lines[i])) continue;
    const j = nextNonEmpty(i + 1);
    if (j < lines.length && TIME_ONLY.test(lines[j].trim())) hasBlock = true;
  }
  if (!hasBlock) return { messages: [], consumedNonEmpty: 0, stats: { skipped: 0 } };

  const messages = [];
  const consumed = new Set();
  // 首块之前的行：按 kv 解析
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const j = nextNonEmpty(i + 1);
    if (isNameLine(lines[i]) && j < lines.length && TIME_ONLY.test(lines[j].trim())) { start = i; break; }
    const kv = lines[i].match(/^(.{1,32}?)[:：]\s*(.+)$/);
    if (kv && !TIME_ONLY.test(lines[i].trim())) {
      messages.push({ sender: kv[1].trim(), time: '', content: kv[2].trim() });
      consumed.add(i);
    }
    start = i + 1;
  }
  // 块模式
  let cur = null;
  let i = start;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (TIME_ONLY.test(t)) {
      if (cur && cur.content.join('').trim()) messages.push(cur);
      cur = { sender: cur ? cur.sender : '', time: t, content: [] };
      consumed.add(i);
      i++;
      continue;
    }
    if (isNameLine(lines[i])) {
      const j = nextNonEmpty(i + 1);
      if (j < lines.length && TIME_ONLY.test(lines[j].trim())) {
        if (cur && cur.content.join('').trim()) messages.push(cur);
        cur = { sender: t, time: lines[j].trim(), content: [] };
        consumed.add(i); consumed.add(j);
        i = j + 1;
        continue;
      }
    }
    if (cur) { cur.content.push(lines[i]); consumed.add(i); }
    i++;
  }
  if (cur && cur.content.join('').trim()) messages.push(cur);
  return { messages, consumedNonEmpty: consumed.size, stats: { skipped: 0 } };
}

/**
 * 自动解析入口。
 * 支持：ChatLab 全系平台（WhatsApp / LINE / Telegram / Discord / Instagram / Google Chat / iMessage-CSV）
 * + 留痕 MemoTrace、QQ 导出 TXT、微信合并转发、通用 JSON/JSONL/CSV、自由粘贴。
 * @returns {{format: string, messages: Array, stats: {parsed:number, skipped:number}}}
 */
function parseAuto(text, opts = {}) {
  const selfName = (opts.selfName || '').trim();
  const trimmed = text.trim();
  let format = 'txt', raw = null;

  // ---------- JSON 家族（Telegram / Instagram / Discord / Google Chat / 通用） ----------
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const v = tryParseJsonLoose(trimmed);
    if (v && typeof v === 'object') {
      const picked = detectJsonPlatform(v);
      if (picked) { raw = picked.items; format = picked.format; }
      else {
        const arr = unwrapArray(v);
        if (arr) { raw = arr.map(normItem).filter(Boolean); format = 'json'; }
      }
    }
  }

  // ---------- CSV（含 Discord DCE 导出与 iMessage CSV） ----------
  if (raw === null && /[,	]/.test(trimmed.split(/\r?\n/)[0]) && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const dce = discordCsvToItems(trimmed);
    if (dce) { raw = dce; format = 'discord-csv'; }
    else {
      const items = csvToItems(trimmed);
      if (items) { raw = items; format = 'csv'; }
    }
  }

  // ---------- TXT 家族（WhatsApp / LINE / DiscordTXT / QQ 与微信时间戳） ----------
  if (raw === null) {
    const wa = parseWhatsAppText(trimmed);
    if (wa) { raw = wa; format = 'whatsapp'; }
  }
  if (raw === null) {
    const ln = parseLineText(trimmed);
    if (ln) { raw = ln; format = 'line'; }
  }
  if (raw === null) {
    const dc = parseDiscordTxt(trimmed);
    if (dc) { raw = dc; format = 'discord-txt'; }
  }
  if (raw === null) { raw = txtToItems(text); format = 'txt'; }

  let messages = raw.filter(m => m && m.text && m.text.trim());
  if (selfName) {
    for (const m of messages) {
      if (m.isSelf === null && m.sender && (m.sender === selfName || m.sender.includes(selfName))) m.isSelf = true;
      else if (m.isSelf === null) m.isSelf = false;
    }
  }
  // 排序（有时间的在前按时间，无时间的保持原序）
  const withTs = messages.filter(m => m.ts && m.ts.includes('T'));
  const without = messages.filter(m => !(m.ts && m.ts.includes('T')));
  withTs.sort((a, b) => a.ts.localeCompare(b.ts));
  messages = [...withTs, ...without];
  return {
    format,
    messages: messages.map(m => ({ ts: m.ts, sender: m.sender, text: m.text, isSelf: m.isSelf })),
    stats: { parsed: messages.length, skipped: Math.max(0, lines(text) - messages.length) },
  };
}


// ============================================================
// ChatLab 系平台格式（规格对齐 ChatLab/ChatLab packages/parser）
// ============================================================

const MONTH_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ZH_AMPM = { 上午: 0, 午前: 0, 凌晨: 0, 早上: 0, 中午: 12, 下午: 12, 午後: 12, 晚上: 12, 半夜: 12 };

/** 12 小时制 → 24 小时制 */
function applyAmPm(hour, marker) {
  let h = hour;
  const m = String(marker || '').toLowerCase().replace(/\./g, '');
  if (/^(pm|下午|午後|晚上)$/.test(m)) { if (h < 12) h += 12; }
  else if (/^(am|上午|午前|凌晨|早上)$/.test(m)) { if (h === 12) h = 0; }
  return h;
}
function isoOf(y, mo, d, h, mi, se) {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se || 0).padStart(2, '0')}`;
}

// ---------- WhatsApp ----------
const WA_LINE_V1 = /^(?:上午|下午|午前|午後|晚上|早上|凌晨|中午)?\s*(\d{1,4})\/(\d{1,2})\/(\d{2,4}),?\s+(?:(上午|下午|午前|午後|晚上|早上|凌晨|中午|[AaPp][Mm]\.?)\s*)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–]\s+(.*)$/m;
const WA_LINE_V2 = /^\[([^\]]+)\]\s+(.*)$/m;
const WA_INNER = /^(\d{1,4})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm]\.?|上午|下午|午前|午後)?$/i;
const WA_SYSTEM = /端到端加密|端對端加密|end-to-end encrypted|创建此群组|建立了此群組|created this group|加入了群组|加入了群組|joined the group|添加了|已新增|added|退出了群组|離開了群組|left the group|移除了|已移除|removed|更改了本群组|已變更本群組|changed this group|the group (?:description|icon)|这条消息已删除|此訊息已刪除|This message was deleted|限时消息|限時訊息|disappearing messages|Messages to this group and calls are now secured/i;
const WA_ALL_PLAIN = /^[^:\n]{1,60}:[\s\u200E]*/;

function looksLikeWhatsApp(text) {
  const head = text.slice(0, 600);
  if (WA_LINE_V1.test(head)) return true;
  const m2 = head.match(WA_LINE_V2);
  return !!(m2 && WA_INNER.test(m2[1]));
}

function parseWhatsAppText(text) {
  if (!looksLikeWhatsApp(text)) return null;
  const items = [];
  let cur = null;
  let sawData = false;
  const flush = () => {
    if (cur && cur.text.trim()) items.push(cur);
    cur = null;
  };
  for (const rawLine of String(text).split(/\r?\n/)) {
    // 去掉 WhatsApp 常见的不可见方向控制符
    let line = rawLine.replace(/[\u200E\u200F\u202A-\u202E\uFEFF]/g, '');
    // 中文导出的 上午/下午 位于时间之前（如「下午9:15」），剥离后按后缀标记处理
    let leadAp = '';
    const lead = line.match(/^(上午|下午|午前|午後|晚上|早上|凌晨|中午)\s*/);
    if (lead) { leadAp = lead[1]; line = line.slice(lead[0].length); }
    let tsStr = null, rest = null;
    let m = line.match(WA_LINE_V1);
    if (m) {
      tsStr = { d: m[1], mo: m[2], y: m[3], ap: m[4], h: m[5], mi: m[6], se: m[7] };
      rest = m[8];
    } else if (WA_LINE_V2.test(line)) {
      const mm = line.match(WA_LINE_V2);
      const inner = mm[1].match(WA_INNER);
      if (inner) { tsStr = { d: inner[1], mo: inner[2], y: inner[3], h: inner[4], mi: inner[5], se: inner[6], ap: inner[7] }; rest = mm[2]; }
    }
    if (tsStr) {
      sawData = true;
      flush();
      if (!tsStr.ap && leadAp) tsStr.ap = leadAp;
      // WhatsApp 行为 day-first：首分量=日，次分量=月，末分量=年
      let d = Number(tsStr.d), mo = Number(tsStr.mo);
      let y = Number(tsStr.y); if (y < 100) y += 2000;
      if (mo > 12) { const t = mo; mo = d; d = t; } // 美区导出 month-first 兜底
      const h = applyAmPm(Number(tsStr.h), tsStr.ap);
      const sep = String(rest || '').match(WA_ALL_PLAIN);
      if (!sep) continue; // 系统消息（无发送者）不计入
      if (WA_SYSTEM.test(String(rest))) continue; // 群系统事件（创建/加入/更改等）不计入
      const sender = sep[0].trim().replace(/:$/, '').trim();
      cur = { ts: isoOf(y, mo, d, h, Number(tsStr.mi), Number(tsStr.se || 0)), sender, text: String(rest).slice(sep[0].length).trim(), isSelf: null, meta: {} };
    } else if (cur) {
      cur.text += '\n' + line;
    } else if (WA_SYSTEM.test(line)) {
      continue;
    }
  }
  flush();
  if (!sawData) return null;
  return items;
}

// ---------- LINE ----------
const LINE_MSG_TAB = /^((?:上午|下午|午前|午後)?\d{1,2}:\d{2}(?:[AaPp][Mm])?)\t([^\t]+)\t(.*)$/;
const LINE_MSG_SPACE = /^((?:上午|下午|午前|午後)?\d{1,2}:\d{2}(?:[AaPp][Mm])?)\s+([^\s]+)\s+(.*)$/;
const LINE_SYS_TAB = /^((?:上午|下午|午前|午後)?\d{1,2}:\d{2}(?:[AaPp][Mm])?)\t\t(.+)$/;
const LINE_DATE = [/^(\d{4})\.(\d{2})\.(\d{2})\s+\w+/, /^(\d{4})\/(\d{1,2})\/(\d{1,2})/, /^[A-Za-z]+,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/];
const LINE_TYPES = { '[photo]': '[图片]', '[照片]': '[图片]', '[写真]': '[图片]', photos: '[图片]', '[voice message]': '[语音]', '[语音信息]': '[语音]', '[語音訊息]': '[语音]', audio: '[语音]', '[video]': '[视频]', '[视频]': '[视频]', '[影片]': '[视频]', videos: '[视频]', '[file]': '[文件]', '[文件]': '[文件]', '[ファイル]': '[文件]', files: '[文件]', '[sticker]': '[贴图]', '[贴图]': '[贴图]', '[スタンプ]': '[贴图]', '[contact]': '[联系人]', '[联系人]': '[联系人]' };

function looksLikeLine(text) {
  const head = text.slice(0, 600);
  return /^\[LINE\] /m.test(head) || /Chat history (?:with|in) /m.test(head) || LINE_MSG_TAB.test(head) || /^\d{4}\.\d{2}\.\d{2}\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/m.test(head);
}

/** LINE 官方导出 TXT：日期行 + "时间\t发送者\t内容"（或空格分隔）；消息后独立时间行 = 时间的兜底归属 */
function parseLineText(text) {
  if (!looksLikeLine(text)) return null;
  const items = [];
  let curDate = null;
  let pending = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\uFEFF/g, '');
    if (!line.trim()) continue;
    let dm = null;
    for (const re of LINE_DATE) { dm = line.match(re); if (dm) break; }
    if (dm) {
      if (dm.length === 4 && /^[A-Za-z]+,/.test(line)) curDate = isoOf(Number(dm[3]), Number(dm[1]), Number(dm[2]), 0, 0, 0).slice(0, 10);
      else curDate = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`;
      pending = [];
      continue;
    }
    let m = line.match(LINE_MSG_TAB) || line.match(LINE_MSG_SPACE);
    if (m) {
      const hm = m[1].match(/(\d{1,2}):(\d{2})/);
      const h = applyAmPm(Number(hm[1]), (m[1].match(/[AaPp][Mm]|上午|下午|午前|午後|中午/) || [])[0]);
      const special = LINE_TYPES[m[3].trim().toLowerCase()];
      items.push({
        ts: curDate ? curDate + 'T' + String(h).padStart(2, '0') + ':' + hm[2] : hm[0],
        sender: m[2].trim(),
        text: special || m[3].trim(),
        isSelf: null, meta: {},
      });
      continue;
    }
    m = line.match(LINE_SYS_TAB);
    if (m) continue; // 系统行（时间		内容）跳过
    // B 形态（官方 App 导出）：发送者行 + 内容行*，独立"纯时间行"收尾归属上一组
    if (TIME_ONLY.test(line.trim())) {
      if (pending.length) {
        const tm2 = line.trim().match(/\d{1,2}:\d{2}/);
        items.push({ ts: (curDate ? curDate + 'T' : '') + (tm2 ? tm2[0] : ''), sender: pending[0], text: pending.slice(1).join(String.fromCharCode(10)).trim(), isSelf: null, meta: {} });
        pending = [];
      }
      continue;
    }
    pending.push(line.trim());
  }
  if (!items.length && pending.length >= 2) {
    items.push({ ts: (curDate ? curDate + 'T' : ''), sender: pending[0], text: pending.slice(1).join(String.fromCharCode(10)).trim(), isSelf: null, meta: {} });
  }
  if (!items.length) return null;
  return items;
}

// ---------- Discord（DiscordChatExporter TXT） ----------
const MONTH_ABBR = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DCE_TXT_LINE = new RegExp('^\\[(\\d{1,2})-(' + MONTH_ABBR + ')-(\\d{2})\\s+(\\d{1,2}):(\\d{2})\\s*([AaPp][Mm])?\\]\\s+(.*)$', 'im');
const DCE_SEP = /[\u001a\u000c]/;

function looksLikeDiscordTxt(text) {
  const head = text.slice(0, 600);
  return DCE_TXT_LINE.test(head);
}

function parseDiscordTxt(text) {
  if (!looksLikeDiscordTxt(text)) return null;
  const items = [];
  let cur = null;
  const flush = () => { if (cur && cur.text.trim()) items.push(cur); cur = null; };
  const SEP_RE = new RegExp('[' + String.fromCharCode(26) + String.fromCharCode(12) + ']', 'g');
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(SEP_RE, '');
    if (!line.trim()) { flush(); continue; }
    const m = line.match(DCE_TXT_LINE);
    if (m) {
      flush();
      let h = Number(m[4]);
      const ap = (m[6] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      cur = { ts: isoOf(2000 + Number(m[3]), MONTH_EN[m[2].toLowerCase()], Number(m[1]), h, Number(m[5]), 0), sender: m[7].trim(), text: '', isSelf: null, meta: {} };
      continue;
    }
    if (cur) cur.text += (cur.text ? '\n' : '') + line;
  }
  flush();
  if (!items.length) return null;
  return items;
}

// ---------- JSON 平台探测与解析 ----------
/** Instagram 的经典编码问题：UTF-8 字节被按 Latin-1 存储成乱码，需反转修复 */
function fixInstagramMojibake(s) {
  let t = String(s || '');
  // Instagram 把 UTF-8 字节按 Latin-1 存储导致乱码，且常叠加多层，迭代解码直到不再出现重音残留
  for (let i = 0; i < 4 && /[À-ÿ]/.test(t); i++) {
    try { t = Buffer.from(t, 'latin1').toString('utf8'); } catch { break; }
  }
  return t;
}
function telegramTextOf(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t.trim();
  if (Array.isArray(t)) {
    return t.map(x => (typeof x === 'string' ? x : (x && x.text) || '')).join('').trim();
  }
  return '';
}

/** Telegram 导出 JSON：单聊天 {name,messages:[...]} / 多聊天 {chats:[{name,messages}]}（取消息最多的一路） */
function parseTelegramJson(v) {
  let chat = null;
  if (Array.isArray(v.chats)) {
    chat = v.chats.filter(c => Array.isArray(c.messages) && c.messages.length)
      .sort((a, b) => b.messages.length - a.messages.length)[0];
  } else if (Array.isArray(v.messages)) {
    chat = v;
  }
  if (!chat) return null;
  const items = [];
  for (const m of chat.messages || []) {
    if (m.type && m.type !== 'message') continue; // service 消息跳过
    const text = telegramTextOf(m.text);
    if (!text) continue;
    items.push({
      ts: normTs(m.date || m.date_unixtime || ''),
      sender: String(m.from || m.actor || m.sender_name || '').trim(),
      text, isSelf: null, meta: {},
    });
  }
  return items.length ? items : null;
}

/** Instagram 导出 JSON：participants+messages（逆序、timestamp_ms、Latin-1 乱码修复） */
function parseInstagramJson(v) {
  if (!Array.isArray(v.messages) || !Array.isArray(v.participants)) return null;
  const items = [];
  const list = v.messages.slice().reverse(); // 最新在前 → 反转为正序
  for (const m of list) {
    let text = fixInstagramMojibake(m.content || '');
    if (!text) {
      if (m.photos || m.media) text = '[图片]';
      else if (m.videos) text = '[视频]';
      else if (m.audio_files) text = '[语音]';
      else if (m.share) text = '[分享]';
      else if (m.sticker) text = '[贴图]';
      else continue;
    }
    items.push({
      ts: normTs(m.timestamp_ms),
      sender: fixInstagramMojibake(m.sender_name || ''),
      text: String(text).trim(), isSelf: null, meta: {},
    });
  }
  return items.length ? items : null;
}

/** Discord（DiscordChatExporter）JSON：{guild, channel, messages:[{timestamp, author:{name}, content}]} */
function parseDiscordJson(v) {
  if (!v || !Array.isArray(v.messages) || !v.channel) return null;
  const items = [];
  for (const m of v.messages) {
    const text = String(m.content || '').trim();
    if (!text) continue;
    items.push({
      ts: normTs(m.timestamp || m.editedTimestamp || ''),
      sender: String((m.author && (m.author.name || m.author.username)) || '').trim(),
      text, isSelf: null, meta: {},
    });
  }
  return items.length ? items : null;
}

/** Google Chat Takeout：{messages:[{creator:{name}, created_date:'2023年1月5日 UTC+8 下午7:02:13', text}]} */
function googleChatDate(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  // 日期与时间分开匹配：'UTC+8' 里的数字会干扰同则正则
  const zh = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const en = t.match(/([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/);
  const tm = t.match(/(上午|下午|凌晨|早上|晚上|中午|UTC[+-]\d+\s*(?:上午|下午|凌晨|早上|晚上|中午)|UTC[+-]\d+|\s)([AaPp][Mm]\.?)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const ap = t.match(/(上午|下午|凌晨|早上|晚上|中午)|([AaPp][Mm])/);
  if (zh && tm) {
    let h = Number(tm[3]);
    const apZh = ((tm[1] || '').trim() + ' ' + ((ap && ap[1]) || '').trim()).trim();
    if (/下午|晚上/.test(apZh)) { if (h < 12) h += 12; }
    if (/上午|凌晨/.test(apZh) && h === 12) h = 0;
    const off = (t.match(/UTC([+-]\d+)/) || [])[1] || '';
    return isoOf(Number(zh[1]), Number(zh[2]), Number(zh[3]), h, Number(tm[4]), Number(tm[5] || 0)) + (off ? off[0] + off.slice(1).padStart(2, '0') + ':00' : '');
  }
  if (en && tm) {
    const mo = MONTH_EN[en[1].toLowerCase()] || 1;
    let h = Number(tm[3]);
    const apEn = ((tm[2] || '') + ((ap && ap[2]) || '')).toLowerCase().replace(/\./g, '');
    if (apEn === 'pm' && h < 12) h += 12;
    if (apEn === 'am' && h === 12) h = 0;
    const off = (t.match(/UTC([+-]\d+)/) || [])[1] || '';
    return isoOf(Number(en[3]), mo, Number(en[2]), h, Number(tm[4]), Number(tm[5] || 0)) + (off ? off[0] + off.slice(1).padStart(2, '0') + ':00' : '');
  }
  return normTs(t);
}

function parseGoogleChatJson(v) {
  if (!Array.isArray(v.messages)) return null;
  if (!v.messages.some(m => m && (m.creator || m.created_date))) return null;
  const items = [];
  for (const m of v.messages) {
    const text = String(m.text || '').trim();
    if (!text) continue;
    items.push({
      ts: normTs(googleChatDate(m.created_date || m.updated_date || '')),
      sender: String((m.creator && (m.creator.name || m.creator.email)) || '').trim(),
      text, isSelf: null, meta: {},
    });
  }
  return items.length ? items : null;
}

/** JSON 平台探测：telegram / instagram / discord / googlechat，未命中返回 null（走通用 JSON） */
function detectJsonPlatform(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  // Telegram 多聊天导出
  if (Array.isArray(v.chats)) {
    const items = parseTelegramJson(v);
    return items ? { items, format: 'telegram' } : null;
  }
  // Telegram 单聊天导出
  if (Array.isArray(v.messages) && (v.name !== undefined || v.id !== undefined) && v.messages.some(m => m && ('from' in m || 'text' in m || m.type === 'message'))) {
    const items = parseTelegramJson(v);
    if (items) return { items, format: 'telegram' };
  }
  // Instagram
  if (Array.isArray(v.participants) && Array.isArray(v.messages)) {
    const items = parseInstagramJson(v);
    if (items) return { items, format: 'instagram' };
  }
  // Google Chat Takeout
  if (Array.isArray(v.messages) && v.messages.some(m => m && (m.creator || m.created_date))) {
    const items = parseGoogleChatJson(v);
    if (items) return { items, format: 'googlechat' };
  }
  // Discord DCE JSON
  if (v.guild && v.channel && Array.isArray(v.messages)) {
    const items = parseDiscordJson(v);
    if (items) return { items, format: 'discord' };
  }
  return null;
}

/** Discord DCE CSV：表头含 messagetype 或 author+content */
function discordCsvToItems(text) {
  const head = (text.split(/\r?\n/)[0] || '').toLowerCase().replace(/["\s]/g, '');
  const isDce = head.includes('messagetype') || (head.includes('author') && head.includes('content'));
  if (!isDce) return null;
  const items = csvToItems(text);
  if (!items) return null;
  // 系统行（membership/join 等 message_type 非默认值）保留内容，不做特殊处理
  return items;
}

function lines(t) { return t.split(/\r?\n/).filter(x => x.trim()).length; }

module.exports = { parseAuto, normTs, txtToItems, csvToItems, tryParseJsonLoose, unwrapArray, normItem,
  parseWhatsAppText, parseLineText, parseDiscordTxt, parseTelegramJson, parseInstagramJson, parseDiscordJson, parseGoogleChatJson, detectJsonPlatform, discordCsvToItems, fixInstagramMojibake };
