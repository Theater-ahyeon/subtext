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

const TIME_KEYS = ['createtime', 'createtimestr', 'timestamp', 'time', 'datetime', 'sendtime', 'sendtime_str', 'date', 'ts'];
const SENDER_KEYS = ['sender', 'sendername', 'sender_name', 'senderremark', 'nick', 'nickname', 'talker', 'talkername', 'user', 'from', 'name', 'senderwxid'];
const CONTENT_KEYS = ['msg', 'message', 'content', 'text', 'strcontent', 'msgcontent', 'body'];
const SELF_KEYS = ['is_sender', 'issender', 'isself', 'self', 'isme', 'is_send'];

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
  let isSelf = pickField(item, SELF_KEYS);
  if (isSelf !== undefined) isSelf = (isSelf === 1 || isSelf === true || isSelf === '1' || isSelf === 'true');
  else isSelf = null;
  return {
    ts: normTs(pickField(item, TIME_KEYS)),
    sender: String(pickField(item, SENDER_KEYS) || '').trim(),
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
const TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?$/;

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
  // 形态A（微信合并转发复制）：昵称行 + 纯时间行 + 内容行*，例如 "她\n12:05\n今天有点累"
  // 形态B：单行 "昵称：内容"
  const wechatBlocks = detectWechatBlocks(lines);
  if (wechatBlocks.length) {
    for (const b of wechatBlocks) {
      items.push({ ts: normTs(b.time), sender: b.sender, text: b.content.replace(/\s+$/, ''), isSelf: null, meta: {} });
    }
    return items.filter(i => i.text);
  }
  for (const line of lines) {
    const kv = line.match(/^(.{1,32}?)[:：]\s*(.+)$/);
    if (kv && !TIME_ONLY.test(kv[1].trim())) items.push({ ts: '', sender: kv[1].trim(), text: kv[2].trim(), isSelf: null, meta: {} });
  }
  return items;
}

/** 识别微信合并转发形态：短昵称行(≤32字,无冒号) + 纯时间行 + 内容行，直到下一个"昵称+时间"块 */
function detectWechatBlocks(lines) {
  const isNameLine = (s) => {
    const t = s.trim();
    return t && t.length <= 32 && !TIME_ONLY.test(t) && !/[:：]/.test(t) && !TS_LINE.test(t);
  };
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!isNameLine(lines[i])) continue;
    // 下一个非空行必须是纯时间行
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length || !TIME_ONLY.test(lines[j].trim())) continue;
    const sender = t;
    const time = lines[j].trim();
    const contentLines = [];
    let k = j + 1;
    while (k < lines.length) {
      const kt = lines[k].trim();
      if (!kt) { k++; continue; }
      // 下一个块的开头：昵称行 + 纯时间行
      if (isNameLine(lines[k])) {
        let m = k + 1;
        while (m < lines.length && !lines[m].trim()) m++;
        if (m < lines.length && TIME_ONLY.test(lines[m].trim())) break;
      }
      contentLines.push(lines[k]);
      k++;
    }
    blocks.push({ sender, time, content: contentLines.join('\n') });
    i = k - 1;
  }
  return blocks;
}

/**
 * 自动解析入口。
 * @returns {{format: string, messages: Array, stats: {parsed:number, skipped:number}}}
 */
function parseAuto(text, opts = {}) {
  const selfName = (opts.selfName || '').trim();
  let format = 'txt', raw = null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const v = tryParseJsonLoose(trimmed);
    const arr = v && unwrapArray(v);
    if (arr) { raw = arr.map(normItem).filter(Boolean); format = 'json'; }
  }
  if (raw === null && /[,\t]/.test(trimmed.split(/\r?\n/)[0]) && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const items = csvToItems(trimmed);
    if (items) { raw = items; format = 'csv'; }
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

function lines(t) { return t.split(/\r?\n/).filter(x => x.trim()).length; }

module.exports = { parseAuto, normTs, txtToItems, csvToItems, tryParseJsonLoose, unwrapArray, normItem };
