'use strict';
/* 无 Electron 依赖的测试套件：node tests/run.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/main/store');
const parser = require('../src/main/parser');
const P = require('../src/main/prompts');
const pipeline = require('../src/main/pipeline');
const { extractJson, normalizeBaseUrl, ADAPTERS, splitSystem, toOpenAIMessages, toGeminiContents, looksLikeVisionUnsupported } = require('../src/main/llm');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓ ' + name); })
    .catch((e) => { failed++; failures.push({ name, err: e }); console.log('  ✗ ' + name + ' —— ' + e.message); });
}

const SETTINGS = { provider: 'mock', baseUrl: '', apiKey: '', model: '', temperature: 0.7, analysisTemperature: 0.3, timeoutMs: 30000 };

async function main() {
  console.log('== parser ==');
  await test('留痕 MemoTrace JSON 解析', () => {
    const json = JSON.stringify([
      { MsgSvrID: '1', type_name: '文本', is_sender: 1, talker: 'wxid_x', sender: '我', msg: '在吗', CreateTime: '1700000000' },
      { MsgSvrID: '2', type_name: '文本', is_sender: 0, talker: 'wxid_x', sender: '她', msg: '刚下班，怎么了', CreateTime: '1700000060' },
      { MsgSvrID: '3', type_name: '图片', is_sender: 0, talker: 'wxid_x', sender: '她', msg: '', CreateTime: '1700000100' },
    ]);
    const r = parser.parseAuto(json, { selfName: '' });
    assert.strictEqual(r.format, 'json');
    assert.strictEqual(r.messages.length, 3);
    assert.strictEqual(r.messages[0].text, '在吗');
    assert.strictEqual(r.messages[0].isSelf, true);
    assert.strictEqual(r.messages[1].isSelf, false);
    assert.strictEqual(r.messages[1].ts, new Date(1700000060 * 1000).toISOString());
    assert.ok(r.messages[2].text.includes('图片'));
  });
  await test('QQ 风格 TXT 解析（时间戳行 + 多行正文）', () => {
    const txt = '2024-01-01 12:00:00 她的昵称(12345)\n今天有点累\n回头再说\n\n2024-01-01 12:05:00 我(67890)\n好的你休息';
    const r = parser.parseAuto(txt, { selfName: '' });
    assert.strictEqual(r.format, 'txt');
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].sender, '她的昵称');
    assert.strictEqual(r.messages[0].text, '今天有点累\n回头再说');
    assert.strictEqual(r.messages[0].ts, '2024-01-01T12:00:00');
  });
  await test('单行冒号格式解析', () => {
    const r = parser.parseAuto('她：吃饭了吗\n我：还没', {});
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].sender, '她');
  });
  await test('CSV 解析（WeChatMsg 风格表头）', () => {
    const csv = 'StrContent,SenderName,CreateTime,is_sender\n"今天加班",她,1700000000,0\n"辛苦了",我,1700000100,1';
    const r = parser.parseAuto(csv, {});
    assert.strictEqual(r.format, 'csv');
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].sender, '她');
    assert.strictEqual(r.messages[1].isSelf, true);
  });
  await test('微信合并转发 TXT 解析（昵称行 + 纯时间行 + 内容）', () => {
    const txt = '她\n12:05\n今天有点累，回头说\n\n我\n12:07\n好的你休息';
    const r = parser.parseAuto(txt, {});
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].sender, '她');
    assert.strictEqual(r.messages[0].text, '今天有点累，回头说');
    assert.strictEqual(r.messages[1].sender, '我');
    assert.ok(!r.messages.some(m => m.text === '05'), '纯时间行不应被当成消息');
  });
  await test('微信时间带 上午/下午 前缀 + 同人连发', () => {
    const txt = '她\n下午2:05\n今天有点累\n她\n下午2:06\n嗯\n我\n下午2:07\n好的你休息';
    const r = parser.parseAuto(txt, {});
    assert.strictEqual(r.messages.length, 3, '连发内容不得丢失: ' + JSON.stringify(r.messages));
    assert.strictEqual(r.messages[0].text, '今天有点累');
    assert.strictEqual(r.messages[1].sender, '她');
    assert.strictEqual(r.messages[1].text, '嗯');
    assert.strictEqual(r.messages[2].sender, '我');
  });
  await test('混合文档：块前 kv 行保留', () => {
    const txt = '备注：手工整理\n她\n12:05\n嗯';
    const r = parser.parseAuto(txt, {});
    assert.ok(r.messages.some(m => m.sender === '备注'), '块前的 kv 行应解析');
    assert.ok(r.messages.some(m => m.sender === '她' && m.text === '嗯'));
  });
  await test('kv 兜底不把整行时间当消息', () => {
    const r = parser.parseAuto('她：吃饭了吗\n12:05\n我：还没', {});
    assert.ok(!r.messages.some(m => m.text === '05' || m.text === '12:05'), '裸时间行不得成为消息');
    assert.strictEqual(r.messages.length, 2);
  });
  await test('selfName 匹配标记本人', () => {
    const r = parser.parseAuto('小明：嗨\n她：嗨', { selfName: '小明' });
    assert.strictEqual(r.messages[0].isSelf, true);
    assert.strictEqual(r.messages[1].isSelf, false);
  });
  await test('时间戳归一化', () => {
    assert.strictEqual(parser.normTs(1700000000), new Date(1700000000 * 1000).toISOString());
    assert.strictEqual(parser.normTs('2024年1月5日 9:30'), '2024-01-05T09:30:00');
    assert.strictEqual(parser.normTs('12:30'), '12:30');
  });

  console.log('== store ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'habitat-test-'));
  const store = new Store();
  store.init(tmp);
  await test('创建/加载/索引/删除人物', () => {
    const b = store.createPerson('测试她', '备注');
    assert.ok(b.id && b.claims.length === 0);
    const loaded = store.loadPerson(b.id);
    assert.strictEqual(loaded.name, '测试她');
    assert.strictEqual(store.listPersons().length, 1);
    store.deletePerson(b.id);
    assert.strictEqual(store.listPersons().length, 0);
    assert.strictEqual(store.loadPerson(b.id), null);
  });
  await test('claims/evidence/stats', () => {
    const b = store.createPerson('S', '');
    store.addEvidence(b, { sourceType: 'chat', text: 'e1', ts: '2024-01-01T10:00:00', sender: '她', isSelf: false });
    store.addEvidence(b, { sourceType: 'feedback', text: 'e2', ts: '', sender: '', isSelf: false });
    store.addClaim(b, { layer: 'temperament', text: '往往先确认目的', epistemic: 'inference', source: 'ai', confidence: 0.7 });
    store.addClaim(b, { layer: 'life', text: '未知作息', epistemic: 'blank', source: 'ai', confidence: 0 });
    store.savePerson(b);
    const r = store.loadPerson(b.id);
    assert.strictEqual(r.evidence.length, 2);
    assert.strictEqual(r.evidence[1].seq, 2);
    const st = store.computeStats(r);
    assert.strictEqual(st.evidence, 2);
    assert.strictEqual(st.byEpistemic.blank, 1);
    assert.strictEqual(st.hitRateTop1, null);
    store.deletePerson(b.id);
  });

  console.log('== 证据截图（存储与安全） ==');
  const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const JPG_HDR = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64)]);
  let mediaPerson;
  await test('图片存证：PNG 魔数校验 + 落盘 + 读取 + 缩略图', () => {
    mediaPerson = store.createPerson('截图她', '');
    const saved = store.saveImage(mediaPerson.id, PNG_1PX);
    assert.ok(saved.media.endsWith('.png'));
    assert.strictEqual(saved.mime, 'image/png');
    const f = store.readImage(mediaPerson.id, saved.media);
    assert.ok(f && f.data.equals(PNG_1PX));
    const t = store.readImage(mediaPerson.id, saved.media, { thumb: true });
    assert.ok(t, 'Web 宿主无 nativeImage 时缩略图=原图，也应可读');
    const e = store.addEvidence(mediaPerson, { sourceType: 'chat', text: '这是聊天截图', media: saved.media, mediaMime: saved.mime });
    assert.strictEqual(e.media, saved.media);
    store.savePerson(mediaPerson);
    assert.ok(fs.existsSync(path.join(store.dataDir, 'media', mediaPerson.id, saved.media)));
  });
  await test('伪造扩展名/非图片字节被拒绝；路径穿越被拒', () => {
    assert.throws(() => store.saveImage(mediaPerson.id, Buffer.from('<script>alert(1)</script>')), /不支持的图片格式/);
    assert.throws(() => store.saveImage(mediaPerson.id, Buffer.alloc(0)), /图片内容为空/);
    assert.throws(() => store.mediaDir('../persons'), /非法的媒体文件名/);
    assert.strictEqual(store.readImage(mediaPerson.id, '../../settings.json'), null);
  });
  await test('15MB 上限拒绝', () => {
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(15 * 1024 * 1024)]);
    assert.throws(() => store.saveImage(mediaPerson.id, big), /超过 15MB/);
  });
  await test('删除证据图片（原图+缩略图）与人物媒体清理', () => {
    const saved = store.saveImage(mediaPerson.id, JPG_HDR);
    assert.ok(saved.media.endsWith('.jpg'));
    store.deleteImage(mediaPerson.id, saved.media);
    assert.strictEqual(store.readImage(mediaPerson.id, saved.media), null);
    // 上一条 PNG 证据的图还在；purge 后目录整体消失
    assert.ok(fs.existsSync(store.mediaDir(mediaPerson.id)));
    store.purgePersonMedia(mediaPerson.id);
    assert.ok(!fs.existsSync(store.mediaDir(mediaPerson.id)));
    store.deletePerson(mediaPerson.id);
  });

  console.log('== prompts ==');
  await test('compileCard：空白层与空层不进卡', () => {
    const b = store.createPerson('CC', '');
    store.addClaim(b, { layer: 'basic', text: '24岁', epistemic: 'fact', source: 'user', confidence: 0.9 });
    store.addClaim(b, { layer: 'temperament', text: '往往先确认目的', epistemic: 'inference', source: 'ai', confidence: 0.6 });
    store.addClaim(b, { layer: 'life', text: '未知作息', epistemic: 'blank', source: 'ai', confidence: 0 });
    store.addClaim(b, { layer: 'life', text: '低置信到近乎弃用的条目', epistemic: 'inference', source: 'ai', confidence: 0.1 });
    const card = P.compileCard(b);
    assert.ok(card.includes('【基础信息】'));
    assert.ok(card.includes('【人物性情】'));
    assert.ok(card.includes('[事实]'), '层级标注应进卡');
    assert.ok(card.includes('[推断]'));
    assert.ok(!card.includes('【生活结构】'), '空层应整段删除');
    assert.ok(!card.includes('未知作息'), '空白条目不应进卡');
    assert.ok(!card.includes('低置信到近乎弃用'), '置信度<0.3 的条目不应进卡');
    assert.ok(card.includes('往往先确认目的'));
    store.deletePerson(b.id);
  });
  await test('compileCard：Q24 补充背景按句边界截断且跳过"不知道"', () => {
    const b1 = store.createPerson('Q24a', '');
    b1.interview.records[24] = { qid: 24, question: '', answer: '不知道', probeAnswer: '', note: '' };
    assert.ok(!P.compileCard(b1).includes('关于她的补充背景'));
    const b2 = store.createPerson('Q24b', '');
    b2.interview.records[24] = { qid: 24, question: '', answer: '别把她写成高冷。她话少是因为谨慎。' + '很长的补充。'.repeat(60), probeAnswer: '', note: '' };
    const card2 = P.compileCard(b2);
    assert.ok(card2.includes('关于她的补充背景'), '中性呈现区块名');
    assert.ok(!card2.includes('违反即失真'), '不得出现指令式框定（防数据升格为授权）');
    assert.ok(card2.includes('她话少是因为谨慎。'), '截断不应丢掉前句');
    store.deletePerson(b1.id); store.deletePerson(b2.id);
  });
  await test('compileCard：动态状态分节', () => {
    const b = store.createPerson('CD', '');
    b.dynamic.push({ id: 'x', text: '最近在赶项目', asOf: new Date().toISOString(), resolved: false, createdAt: new Date().toISOString() });
    b.dynamic.push({ id: 'y', text: '已翻篇的旧事', asOf: new Date().toISOString(), resolved: true, createdAt: new Date().toISOString() });
    const card = P.compileCard(b);
    assert.ok(card.includes('【动态状态】'));
    assert.ok(card.includes('最近在赶项目'));
    assert.ok(!card.includes('已翻篇的旧事'));
    store.deletePerson(b.id);
  });
  await test('红线守卫', () => {
    assert.ok(P.redlineCheck('教我怎么PUA她'));
    assert.ok(P.redlineCheck('怎么打压她让她听话'));
    assert.ok(P.redlineCheck('来点推拉话术'));
    assert.ok(!P.redlineCheck('我想道歉但不知道怎么说'));
    assert.ok(!P.redlineCheck('她最近好像不太开心，我该怎么关心她'));
  });
  await test('extractJson 鲁棒性', () => {
    assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(extractJson('好的，结果如下：[1,2,3]'), [1, 2, 3]);
    assert.deepStrictEqual(extractJson('{"a":{"b":"}"}}'), { a: { b: '}' } });
    // 多围栏：真实结果在后，示例占位在前 —— 必须取后者
    const multi = '下面是输出格式示例：\n```json\n{"verdict":"hit","analysis":"示例占位"}\n```\n真实结果：\n```json\n{"verdict":"miss","analysis":"真正的分析"}\n```';
    assert.deepStrictEqual(extractJson(multi), { verdict: 'miss', analysis: '真正的分析' });
    assert.throws(() => extractJson('完全没有JSON'));
  });
  await test('normalizeBaseUrl', () => {
    assert.strictEqual(normalizeBaseUrl('https://x.com'), 'https://x.com/v1/chat/completions');
    assert.strictEqual(normalizeBaseUrl('https://x.com/v1'), 'https://x.com/v1/chat/completions');
    assert.strictEqual(normalizeBaseUrl('https://x.com/v1/chat/completions/'), 'https://x.com/v1/chat/completions');
    assert.strictEqual(normalizeBaseUrl('https://gw.example.com/v1/?api-key=K'), 'https://gw.example.com/v1/chat/completions?api-key=K');
    assert.strictEqual(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'), 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  console.log('== 多协议适配器 ==');
  const MSGS = [{ role: 'system', content: '你是孪生引擎' }, { role: 'user', content: '你好' }, { role: 'assistant', content: '嗯？' }, { role: 'user', content: '在吗' }];
  await test('anthropic 适配器：system 独立传输 + 必填 max_tokens + x-api-key 头', () => {
    const a = ADAPTERS.anthropic.build({ settings: { baseUrl: '', apiKey: 'sk-ant-x', model: 'claude-sonnet-4-5' }, messages: MSGS, temperature: 0.5, maxTokens: 1024 });
    assert.strictEqual(a.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(a.headers['x-api-key'], 'sk-ant-x');
    assert.strictEqual(a.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(a.body.system, '你是孪生引擎');
    assert.ok(!JSON.stringify(a.body.messages).includes('孪生引擎'), 'system 不得混进 messages');
    assert.strictEqual(a.body.max_tokens, 1024);
    assert.strictEqual(a.body.messages.length, 3);
    assert.strictEqual(a.body.messages[0].role, 'user');
    assert.strictEqual(ADAPTERS.anthropic.parse({ content: [{ type: 'text', text: 'A' }, { type: 'tool_use' }, { type: 'text', text: 'B' }] }), 'AB');
  });
  await test('gemini 适配器：URL 含模型名 + role 映射 model + systemInstruction', () => {
    const a = ADAPTERS.gemini.build({ settings: { baseUrl: '', apiKey: 'AIza-x', model: 'gemini-2.5-flash' }, messages: MSGS, temperature: 0.5, maxTokens: 1024 });
    assert.strictEqual(a.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.strictEqual(a.headers['x-goog-api-key'], 'AIza-x');
    assert.strictEqual(a.body.systemInstruction.parts[0].text, '你是孪生引擎');
    assert.deepStrictEqual(a.body.contents.map(c => c.role), ['user', 'model', 'user']);
    assert.strictEqual(a.body.generationConfig.maxOutputTokens, 1024);
    assert.strictEqual(ADAPTERS.gemini.parse({ candidates: [{ content: { parts: [{ text: '嗨' }, { text: '呀' }] } }] }), '嗨呀');
    assert.ok(ADAPTERS.gemini.modelsUrl({ baseUrl: '' }).endsWith('/v1beta/models'));
    assert.deepStrictEqual(ADAPTERS.gemini.parseModels({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-x', supportedGenerationMethods: ['embedContent'] }] }), ['gemini-2.5-flash']);
  });
  await test('azure 适配器：api-key 头 + 部署地址原样 + body 不含 model', () => {
    const url = 'https://r.openai.azure.com/openai/deployments/d1/chat/completions?api-version=2024-10-21';
    const a = ADAPTERS.azure.build({ settings: { baseUrl: url, apiKey: 'az-k', model: '' }, messages: MSGS, temperature: 0.5 });
    assert.strictEqual(a.url, url);
    assert.strictEqual(a.headers['api-key'], 'az-k');
    assert.ok(!('Authorization' in a.headers));
    assert.ok(!('model' in a.body));
    assert.strictEqual(a.body.messages.length, 4, 'azure 走 openai 消息形态（system 保留在 messages）');
    assert.strictEqual(ADAPTERS.azure.modelsUrl, null);
  });
  await test('ollama 适配器：无密钥 + /api/chat + options.temperature', () => {
    const a = ADAPTERS.ollama.build({ settings: { baseUrl: '', apiKey: '', model: 'qwen3:14b' }, messages: MSGS, temperature: 0.6 });
    assert.strictEqual(a.url, 'http://localhost:11434/api/chat');
    assert.ok(!('Authorization' in a.headers));
    assert.strictEqual(a.body.options.temperature, 0.6);
    assert.strictEqual(a.body.stream, false);
    assert.strictEqual(ADAPTERS.ollama.parse({ message: { content: '本地回复' } }), '本地回复');
    assert.ok(ADAPTERS.ollama.modelsUrl({ baseUrl: '' }).endsWith('/api/tags'));
  });
  await test('openai 兼容适配器：网关 /v1 补全与 Bearer 头', () => {
    const a = ADAPTERS.openai.build({ settings: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'dk-x', model: 'deepseek-chat' }, messages: MSGS, temperature: 0.7 });
    assert.strictEqual(a.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.strictEqual(a.headers.Authorization, 'Bearer dk-x');
    assert.strictEqual(a.body.model, 'deepseek-chat');
    assert.strictEqual(a.body.messages.length, 4);
  });
  await test('splitSystem：无 system 时输出原消息', () => {
    const { system, messages } = splitSystem([{ role: 'user', content: 'hi' }]);
    assert.strictEqual(system, '');
    assert.strictEqual(messages.length, 1);
  });
  await test('chat() 对不存在的 provider 报可读错误', async () => {
    let msg = '';
    try { await require('../src/main/llm').chat({ provider: 'nope' }, [{ role: 'user', content: 'x' }], {}); } catch (e) { msg = e.message; }
    assert.ok(/不支持的 Provider/.test(msg));
  });
  console.log('== llm 多模态消息转换 ==');
  const IMG_B64 = PNG_1PX.toString('base64');
  const VMSG = [
    { role: 'system', content: '你是归纳器' },
    { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image', mime: 'image/png', dataB64: IMG_B64 }] },
    { role: 'assistant', content: '看到了' },
  ];
  await test('openai 兼容：图片转 image_url data URL，纯文本消息不变形', () => {
    const a = ADAPTERS.openai.build({ settings: { baseUrl: '', apiKey: 'k', model: 'm' }, messages: VMSG, temperature: 0.5 });
    const m = a.body.messages;
    assert.strictEqual(m[0].content, '你是归纳器', '纯文本 system 原样直传');
    assert.strictEqual(m[1].content[0].type, 'text');
    assert.strictEqual(m[1].content[1].image_url.url, `data:image/png;base64,${IMG_B64}`);
    assert.strictEqual(m[2].content, '看到了');
  });
  await test('anthropic：system 独立 + image source base64 块', () => {
    const a = ADAPTERS.anthropic.build({ settings: { baseUrl: '', apiKey: 'k', model: 'claude' }, messages: VMSG, temperature: 0.5, maxTokens: 1024 });
    assert.strictEqual(a.body.system, '你是归纳器');
    const m = a.body.messages;
    assert.strictEqual(m.length, 2);
    assert.strictEqual(m[0].content[1].source.type, 'base64');
    assert.strictEqual(m[0].content[1].source.data, IMG_B64);
    assert.strictEqual(m[0].content[1].source.media_type, 'image/png');
  });
  await test('gemini：role 映射 + inlineData parts', () => {
    const a = ADAPTERS.gemini.build({ settings: { baseUrl: '', apiKey: 'k', model: 'gemini-2.5-flash' }, messages: VMSG, temperature: 0.5 });
    assert.strictEqual(a.body.systemInstruction.parts[0].text, '你是归纳器');
    assert.strictEqual(a.body.contents[0].role, 'user');
    assert.strictEqual(a.body.contents[0].parts[1].inlineData.mimeType, 'image/png');
    assert.strictEqual(a.body.contents[0].parts[1].inlineData.data, IMG_B64);
    assert.strictEqual(a.body.contents[1].role, 'model');
  });
  await test('ollama：图片转 images 数组', () => {
    const a = ADAPTERS.ollama.build({ settings: { baseUrl: '', model: 'llava' }, messages: VMSG, temperature: 0.5 });
    assert.strictEqual(a.body.messages[0].role, 'system', 'ollama 协议 system 是合法 role，原样直传');
    const m = a.body.messages[1];
    assert.strictEqual(m.content, '看这张图');
    assert.deepStrictEqual(m.images, [IMG_B64]);
  });
  await test('data: 前缀与多模态空文本容错', () => {
    const out = toOpenAIMessages([{ role: 'user', content: [{ type: 'image', mime: 'image/png', dataB64: 'data:image/png;base64,' + IMG_B64 }] }]);
    assert.ok(out[0].content[0].image_url.url.endsWith(IMG_B64), 'data: 前缀应被剥离一次');
    const gem = toGeminiContents([{ role: 'user', content: [] }]);
    assert.strictEqual(gem.contents[0].parts.length, 1, '空 parts 补占位文本');
  });
  await test('looksLikeVisionUnsupported 识别模型不支持图片', () => {
    assert.ok(looksLikeVisionUnsupported('Error: image input is not supported for this model'));
    assert.ok(looksLikeVisionUnsupported('Invalid content type: expected text, got image'));
    assert.ok(!looksLikeVisionUnsupported('rate limit exceeded, too many requests'));
    assert.ok(!looksLikeVisionUnsupported('请求超时（90 秒）'));
  });

  console.log('== pipeline（mock provider 全流程） ==');
  const store2 = new Store();
  store2.init(fs.mkdtempSync(path.join(os.tmpdir(), 'habitat-test2-')));
  const bundle = store2.createPerson('流程她', '');
  await test('导入 → 归纳生成 claims 与 blanks；无溯源 fact 降级为 inference', async () => {
    for (const t of ['她：在忙，回头说', '她：周五之前别找我，赶项目']) {
      store2.addEvidence(bundle, { sourceType: 'chat', text: t, ts: '', sender: '她', isSelf: false });
    }
    const r = await pipeline.inductEvidence(store2, bundle, SETTINGS);
    assert.ok(r.newClaims > 0, '应有新增条目');
    assert.ok(bundle.claims.some(c => c.source === 'ai'));
    assert.ok(bundle.claims.every(c => c.epistemic !== 'fact' || c.refs.length > 0), '无溯源不得为 fact');
  });
  await test('截图证据：进入多模态归纳消息 + 超量图片只占位不直发', async () => {
    const b2 = store2.createPerson('截图流程她', '');
    const saved = store2.saveImage(b2.id, PNG_1PX);
    store2.addEvidence(b2, { sourceType: 'chat', text: '她的朋友圈截图', media: saved.media, mediaMime: saved.mime });
    store2.addEvidence(b2, { sourceType: 'chat', text: '一张纯文本消息' });
    store2.savePerson(b2);
    const b2Loaded = store2.loadPerson(b2.id);
    const chunk = [...b2Loaded.evidence].sort((x, y) => x.seq - y.seq);
    const msgs = pipeline.inductionMessages('PROMPT', chunk, store2, b2Loaded);
    assert.ok(Array.isArray(msgs[0].content), '含图批次应为多模态块数组');
    assert.ok(msgs[0].content.some(p => p.type === 'image' && p.dataB64 === PNG_1PX.toString('base64')));
    // 超出 MAX_IMAGES_PER_CHUNK 的图不直发
    const many = [];
    for (let i = 0; i < pipeline.MAX_IMAGES_PER_CHUNK + 3; i++) {
      many.push({ seq: i + 1, id: 'x' + i, text: '图' + i, media: saved.media, mediaMime: saved.mime });
    }
    const msgs2 = pipeline.inductionMessages('P', many, store2, b2);
    assert.strictEqual(msgs2[0].content.filter(p => p.type === 'image').length, pipeline.MAX_IMAGES_PER_CHUNK);
    // 无图批次仍是纯字符串
    const msgs3 = pipeline.inductionMessages('P', [{ seq: 1, id: 't', text: '纯文本' }], store2, b2);
    assert.strictEqual(typeof msgs3[0].content, 'string');
    store2.deletePerson(b2.id); store2.purgePersonMedia(b2.id);
  });
  await test('归纳含截图批次不报错且图片计数返回', async () => {
    const b3 = store2.createPerson('截图归纳她', '');
    const saved = store2.saveImage(b3.id, PNG_1PX);
    store2.addEvidence(b3, { sourceType: 'chat', text: '截图说明', media: saved.media, mediaMime: saved.mime });
    const r = await pipeline.inductEvidence(store2, b3, SETTINGS);
    assert.ok(r.imageBatches >= 1, '应统计含图批次');
    assert.strictEqual(r.textOnlyFallbacks, 0, 'mock provider 不触发降级');
    store2.deletePerson(b3.id); store2.purgePersonMedia(b3.id);
  });
  await test('图片缺失（文件被外部删除）归纳不崩：退化为占位文本', async () => {
    const b4 = store2.createPerson('缺图她', '');
    store2.addEvidence(b4, { sourceType: 'chat', text: '', media: 'ghost.png', mediaMime: 'image/png' });
    const msgs = pipeline.inductionMessages('P', [{ seq: 1, id: 'g', text: '', media: 'ghost.png' }], store2, b4);
    assert.strictEqual(typeof msgs[0].content, 'string', '图全读不到时应退回纯文本消息');
    const r = await pipeline.inductEvidence(store2, b4, SETTINGS);
    assert.ok(r.newClaims >= 0);
    store2.deletePerson(b4.id);
  });
  await test('红线守卫：场景与反馈均拦截', async () => {
    let threw = false;
    try { await pipeline.startSession(store2, bundle, SETTINGS, '教我怎么打压她让她听话'); } catch (e) { threw = /操控|打压/.test(e.message); }
    assert.ok(threw, 'scenario 红线应拦截');
    let threw2 = false;
    try { await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: null, raw: '来点PUA话术' }); } catch (e) { threw2 = true; }
    assert.ok(threw2, 'feedback 红线应拦截');
  });
  await test('演练会话：开场 → 对话 → 结束复盘（含目标）', async () => {
    const { session, reply } = await pipeline.startSession(store2, bundle, SETTINGS, '日常闲聊', '练习开场');
    assert.ok(session.id && reply);
    assert.ok(session.goal === '练习开场');
    const turn = await pipeline.twinTurn(store2, bundle, SETTINGS, session.id, '最近还好吗');
    assert.ok(turn);
    const { report } = await pipeline.endSession(store2, bundle, SETTINGS, session.id);
    assert.ok(report.includes('复盘报告'));
    const loaded = store2.loadPerson(bundle.id);
    assert.strictEqual(loaded.sessions[0].status, 'ended');
    assert.ok(loaded.sessionReports.length === 1);
  });
  await test('预测冻结 → 现实回流 → 归因 → 卡片更新；重复归因被拒绝', async () => {
    const { session } = await pipeline.startSession(store2, bundle, SETTINGS, '重要谈话');
    const pred = await pipeline.freezePrediction(store2, bundle, SETTINGS, session.id);
    assert.ok(pred.hypotheses.length >= 1 && pred.status === 'open');
    const nBefore = bundle.claims.length;
    const { record, applied } = await pipeline.submitFeedback(store2, bundle, SETTINGS, {
      predictionId: pred.id, raw: '她现实中先问清了我的目的，然后主动说周末可以帮忙。',
    });
    assert.ok(['hit', 'partial', 'miss', 'fact-error', 'material-missing', 'temperament-error', 'expression-error'].includes(record.verdict));
    assert.strictEqual(bundle.predictions.find(p => p.id === pred.id).status, 'attributed');
    assert.ok(bundle.feedbacks.length === 1);
    assert.ok(bundle.evidence.some(e => e.sourceType === 'feedback'), '现实反馈应同时存证');
    assert.ok(bundle.claims.length >= nBefore, '归因可新增条目');
    let threw = false;
    try { await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: pred.id, raw: '再交一次' }); } catch (e) { threw = /已差异分析/.test(e.message); }
    assert.ok(threw, '重复归因应被拒绝');
    let threw2 = false;
    try { await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: 'not-exists', raw: 'x' }); } catch { threw2 = true; }
    assert.ok(threw2, '无效预测单应报错');
  });
  await test('归因撤销：恢复卡片到归因前状态，闭环不超 100%', async () => {
    const { session } = await pipeline.startSession(store2, bundle, SETTINGS, '撤回测试');
    const pred = await pipeline.freezePrediction(store2, bundle, SETTINGS, session.id);
    const nBefore = bundle.claims.length;
    const { record } = await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: pred.id, raw: '她主动帮我了' });
    const reverted = pipeline.undoAttribution(store2, bundle, record.id);
    assert.strictEqual(bundle.claims.length, nBefore, '撤销后应恢复条目数');
    assert.strictEqual(bundle.predictions.find(p => p.id === pred.id).status, 'open', '预测单应回到待回流');
    // 撤销后重交：闭环率不得超 100%（feedback 退出分子后再计入一次）
    const { record: r2 } = await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: pred.id, raw: '她主动帮我了（再次）' });
    const stats = store2.computeStats(bundle);
    assert.ok(stats.loopCompletion <= 1, `loopCompletion 应 ≤ 100%，实际 ${stats.loopCompletion}`);
    assert.ok(stats.linkedFeedbacks <= stats.predictions);
    let threw = false;
    try { pipeline.undoAttribution(store2, bundle, record.id); } catch { threw = true; }
    assert.ok(threw, '不能重复撤销');
  });
  await test('访谈写入一律以推断层级落库（用户陈述无事实地位）', async () => {
    const b = store2.createPerson('访谈层', '');
    b.interview.suggestions = [
      { layer: 'temperament', text: '重视约定，认定的责任不会轻易放下', kind: 'fact', written: false },
      { layer: 'life', text: '可能对临时变动敏感', kind: 'inference', written: false },
    ];
    pipeline.interviewWriteClaims(store2, b, [0, 1]);
    assert.ok(b.claims.every(c => c.source !== 'user' || c.epistemic === 'inference'), '用户陈述不得为 fact');
    // 非法索引不污染
    pipeline.interviewWriteClaims(store2, b, ['__proto__', -1, 99]);
    assert.strictEqual(b.claims.length, 2);
    store2.deletePerson(b.id);
  });
  await test('24问访谈：回答 → 追问 → 跳过 → 终结 → 写入', async () => {
    const r1 = await pipeline.interviewAnswer(store2, bundle, SETTINGS, { qid: 1, answer: '她一个人也能站得很稳', skipped: false });
    assert.ok(r1.probe, '抽象回答应触发追问');
    await pipeline.interviewProbeAnswer(store2, bundle, SETTINGS, { qid: 1, answer: '全班反对时她也一个人留到最后' });
    const r2 = await pipeline.interviewAnswer(store2, bundle, SETTINGS, { qid: 2, answer: '', skipped: true });
    assert.strictEqual(bundle.interview.records[2].note, '暂未确定');
    await pipeline.interviewAnswer(store2, bundle, SETTINGS, { qid: 24, answer: '别把她写成高冷', skipped: false });
    const fin = await pipeline.interviewFinalize(store2, bundle, SETTINGS);
    assert.ok(fin.suggestions.length >= 1);
    const written = pipeline.interviewWriteClaims(store2, bundle, fin.suggestions.map((s, i) => i));
    assert.ok(written.length >= 1);
    assert.ok(bundle.claims.some(c => c.source === 'user'), '应有用户陈述条目');
  });
  await test('话题雷达：空白与待确认', () => {
    const radar = pipeline.topicRadar(bundle);
    assert.ok(Array.isArray(radar));
  });
  await test('相似条目去重', () => {
    assert.ok(pipeline.similar('她往往先确认目的再投入', '她往往先确认目的再投入程度'));
    assert.ok(!pipeline.similar('完全不同的两个内容条目甲', '另一个话题的条目乙关于工作'));
  });

  console.log('== 安全 ==');
  await test('归因更新只允许受控 action', () => {
    const b = store2.createPerson('安全她', '');
    const applied = pipeline.applyUpdates(b, [
      { action: 'add', layer: 'temperament', text: '新条目' },
      { action: 'evil', layer: 'basic', text: '恶意' },
      { action: 'add', layer: 'notalayer', text: '非法层' },
      null,
    ]);
    assert.strictEqual(applied.length, 1);
    assert.strictEqual(b.claims.length, 1);
    store2.deletePerson(b.id);
  });


  // ================= 事件记忆 / 校准 =================
  console.log('== 事件记忆 ==');
  await test('hash 向量：确定性 + 归一化 + base64 往返', () => {
    const m = require('../src/main/memory');
    const a = m.hashEmbed('她因为信任的人才会被打乱计划而生气');
    const b = m.hashEmbed('她因为信任的人才会被打乱计划而生气');
    assert.deepStrictEqual([...a], [...b], '同一文本向量必须一致');
    let norm = 0; for (const v of a) norm += v * v;
    assert.ok(Math.abs(norm - 1) < 1e-5, '向量应 L2 归一化');
    const back = m.b64ToF32(m.f32ToB64(a));
    assert.deepStrictEqual([...back], [...a], 'base64 往返无损');
    const sim = m.cosine(a, m.hashEmbed('她讨厌被临时打乱安排'));
    const dif = m.cosine(a, m.hashEmbed('完全无关的股票行情走势'));
    assert.ok(sim > dif, '相近文本相似度应高于无关文本');
  });
  await test('事件记忆写入与检索（mock 路径走本地向量）', async () => {
    const store3 = new Store();
    store3.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-mem-')));
    const b3 = store3.createPerson('记忆测试', '');
    const { memory } = require('../src/main/memory') && { memory: require('../src/main/memory') };
    await memory.rememberReality(store3, b3, SETTINGS, { text: '她说周末要加班，让我别等她了', ref: { evidenceSeq: 1 } });
    await memory.rememberReality(store3, b3, SETTINGS, { text: '她主动提到想学潜水，问我要不要一起', ref: { evidenceSeq: 2 } });
    const hit = await memory.recall(b3, SETTINGS, '周末加班 不要等', { k: 2 });
    assert.ok(hit.items.length >= 1, '应召回至少一条');
    assert.strictEqual(hit.items[0].text.includes('加班'), true, '最相似应为加班条目');
    assert.strictEqual(hit.fallback, true, 'mock 设置应走本地降级并如实标记');
    const listed = memory.list(b3);
    assert.strictEqual(listed.total, 2);
    assert.strictEqual(listed.items[0].ref.evidenceSeq, 2);
    memory.remove(b3, listed.items[0].id);
    assert.strictEqual(memory.list(b3).total, 1);
    memory.clear(b3);
    assert.strictEqual(memory.list(b3).total, 0);
    store3.deletePerson(b3.id);
  });
  await test('演练复盘自动写入事件记忆，重复复盘不重复记忆（ledger）', async () => {
    const store4 = new Store();
    store4.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-mem2-')));
    const b4 = store4.createPerson('Ledger测试', '');
    const { session } = await pipeline.startSession(store4, b4, SETTINGS, '化解冷战');
    await pipeline.endSession(store4, b4, SETTINGS, session.id);
    const m = require('../src/main/memory');
    const n1 = m.list(b4).total;
    assert.ok(n1 >= 1, '复盘后应有事件记忆');
    const sessionRow = b4.sessions.find(s => s.id === session.id);
    sessionRow.status = 'active';
    (b4.sessionReports || []).pop();
    await pipeline.endSession(store4, b4, SETTINGS, session.id);
    assert.strictEqual(m.list(b4).total, n1, '同一演练不应重复记忆');
    store4.deletePerson(b4.id);
  });

  console.log('== 学习率与校准 ==');
  await test('差异分析学习率：fact-error 足额下调，hit 仅微调，model-bias 不更新', () => {
    const store5 = new Store();
    store5.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-lr-')));
    const b5 = store5.createPerson('LR测试', '');
    store5.addClaim(b5, { layer: 'temperament', text: '她面对道歉往往先确认动机', epistemic: 'inference', source: 'ai', confidence: 0.7 });
    // fact-error（α=1.0）：deprecate 下调 0.3
    pipeline.applyUpdates(b5, [{ action: 'deprecate', claimId: b5.claims[0].id, reason: '事实矛盾' }], 'fact-error');
    assert.ok(Math.abs(b5.claims[0].confidence - 0.4) < 1e-9, 'fact-error 应足额下调到 0.4');
    b5.claims[0].confidence = 0.7;
    // miss（α=0.8）：下调 0.24
    pipeline.applyUpdates(b5, [{ action: 'deprecate', claimId: b5.claims[0].id, reason: '落空' }], 'miss');
    assert.ok(Math.abs(b5.claims[0].confidence - 0.46) < 1e-9, 'miss 应按 α=0.8 下调到 0.46');
    // hit（α=0.15）：add 新条目置信度更保守
    const n = b5.claims.length;
    pipeline.applyUpdates(b5, [{ action: 'add', layer: 'life', text: '她近期在准备考试', reason: '现实反馈' }], 'hit');
    assert.strictEqual(b5.claims.length, n + 1);
    assert.ok(b5.claims[n].confidence < 0.5, 'hit 下新增条目置信度应保守 (<0.5)');
    // model-bias：完全不更新
    const before = b5.claims.length;
    const applied = pipeline.applyUpdates(b5, [{ action: 'add', layer: 'life', text: '不该被加入', reason: 'x' }], 'model-bias');
    assert.strictEqual(applied.length, 0);
    assert.strictEqual(b5.claims.length, before);
    store5.deletePerson(b5.id);
  });
  await test('统计：model-bias 不进命中率单列计数；Brier 按 topProb 计算', async () => {
    const store6 = new Store();
    store6.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-brier-')));
    const b6 = store6.createPerson('Brier测试', '');
    const mkAttr = (i, verdict, topProb) => ({
      id: 'attr-' + i, feedbackId: 'fb-' + i, predictionId: 'pred-' + i,
      verdict, topProb, analysis: '', updates: [], undone: false, createdAt: new Date().toISOString(),
    });
    b6.predictions.push({ id: 'pred-1', hypotheses: [], expected: '', frozenAt: '', status: 'attributed' });
    b6.predictions.push({ id: 'pred-2', hypotheses: [], expected: '', frozenAt: '', status: 'attributed' });
    b6.predictions.push({ id: 'pred-3', hypotheses: [], expected: '', frozenAt: '', status: 'attributed' });
    b6.feedbacks.push({ id: 'fb-1', predictionId: 'pred-1', raw: '', createdAt: '' });
    b6.feedbacks.push({ id: 'fb-2', predictionId: 'pred-2', raw: '', createdAt: '' });
    b6.feedbacks.push({ id: 'fb-3', predictionId: 'pred-3', raw: '', createdAt: '' });
    b6.attributions.push(mkAttr(1, 'hit', 0.8));
    b6.attributions.push(mkAttr(2, 'miss', 0.9));
    b6.attributions.push(mkAttr(3, 'model-bias', 0.5));
    const st = store6.computeStats(b6);
    assert.strictEqual(st.attributions, 2, 'model-bias 不进命中率分母');
    assert.strictEqual(st.modelBiased, 1, 'model-bias 应单列计数');
    assert.strictEqual(st.hitRateTop1, 0.5);
    // Brier: (0.8-1)^2 + (0.9-0)^2 = 0.04 + 0.81 = 0.85，均值 0.425
    assert.ok(Math.abs(st.brierTop1 - 0.425) < 1e-9, 'brierTop1 应为 0.425');
    assert.strictEqual(st.brierSamples, 2, 'model-bias 不进 Brier');
    store6.deletePerson(b6.id);
  });


  // ================= 人物档案槽位 / 深度分析 =================
  console.log('== 档案与分析 ==');
  await test('档案槽位：AI 提取不覆盖用户手填，非法键被丢弃', () => {
    const store7 = new Store();
    store7.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-prof-')));
    const b7 = store7.createPerson('档案测试', '');
    pipeline.applyProfile(b7, { occupation: { value: '编辑（用户填）', source: 'user' } }, 'user');
    pipeline.applyProfile(b7, { occupation: { value: '编辑（AI 提取）', source: 'ai' }, gender: { value: '女', source: 'ai' } }, 'ai');
    assert.ok(b7.profile.slots.occupation.value.includes('用户填'), '用户手填不应被 AI 覆盖');
    assert.strictEqual(b7.profile.slots.gender.value, '女');
    assert.strictEqual(b7.profile.slots.evil, undefined, '未知键不应入库');
    // AI 提取多值槽位
    pipeline.applyProfile(b7, { foods: [{ text: '杨枝甘露' }], hobbies: [{ text: '攀岩' }, { text: ' ' }] }, 'ai');
    assert.deepStrictEqual(b7.profile.slots.foods.map(x => x.text), ['杨枝甘露']);
    assert.deepStrictEqual(b7.profile.slots.hobbies.map(x => x.text), ['攀岩'], '空白项应过滤');
    store7.deletePerson(b7.id);
  });
  await test('档案提取（mock）：从理解卡提取有依据的项', async () => {
    const store8 = new Store();
    store8.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-prof2-')));
    const b8 = store8.createPerson('提取测试', '');
    store8.addClaim(b8, { layer: 'basic', text: '她是出版业编辑', epistemic: 'fact', source: 'evidence', confidence: 0.9 });
    const prof = await pipeline.profileExtract(store8, b8, SETTINGS);
    assert.strictEqual(prof.slots.occupation.value, '编辑');
    assert.strictEqual(prof.slots.occupation.source, 'ai');
    store8.deletePerson(b8.id);
  });
  await test('深度分析（mock）：人物全息报告与场景推演', async () => {
    const store9 = new Store();
    store9.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-ana-')));
    const b9 = store9.createPerson('分析测试', '');
    const person = await pipeline.analyzePerson(store9, b9, SETTINGS);
    assert.ok(person.report.includes('## 一、'), '人物报告应为固定结构 Markdown');
    const scn = await pipeline.analyzeScenario(store9, b9, SETTINGS, '周末约她出来');
    assert.ok(scn.report.includes('## 一、'), '场景推演应为固定结构 Markdown');
    assert.ok(Array.isArray(scn.recalled));
    let threw = false;
    try { await pipeline.analyzeScenario(store9, b9, SETTINGS, '   '); } catch { threw = true; }
    assert.ok(threw, '空场景应报错');
    store9.deletePerson(b9.id);
  });


  // ================= ChatLab 系导入格式 =================
  console.log('== 国际平台导入 ==');
  await test('WhatsApp TXT：安卓 day-first + 续行 + 系统行跳过 + 12h 制', () => {
    const t = [
      '3/1/25, 21:30 - Alice: 你好呀',
      '后续第二行',
      '4/1/25, 09:12 - Bob: 早上好',
      '4/1/25, 09:13 - Bob: 消息和通话已进行端到端加密',
      '4/1/25, 09:14 - Bob: [图片]',
      '4/1/25, 下午9:15 - Alice: 收到',
    ].join('\n');
    const r = parser.parseAuto(t, { selfName: 'Bob' });
    assert.strictEqual(r.format, 'whatsapp');
    assert.strictEqual(r.messages.length, 4, '系统行不计入');
    const first = r.messages[0];
    assert.strictEqual(first.ts, '2025-01-03T21:30:00', 'day-first：3/1/25 → 1月3日');
    assert.ok(first.text.includes('后续第二行'), '续行应并入上一条');
    assert.strictEqual(r.messages[1].isSelf, true, 'selfName 标记本人');
    assert.strictEqual(r.messages[3].ts.slice(11, 13), '21', '下午9点应为 21 点');
  });
  await test('WhatsApp TXT：iOS 方括号变体', () => {
    const t = '[16/03/25, 21:30:12] Alice: iOS 版本\n[16/03/25, 21:31:00] Alice: 第二条';
    const r = parser.parseAuto(t, {});
    assert.strictEqual(r.format, 'whatsapp');
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].ts, '2025-03-16T21:30:12');
  });
  await test('LINE TXT：TSV 形态 + 日期行', () => {
    const t = [
      '[LINE] Alice',
      '2025.03.01 Monday',
      '下午12:05\tBob\tHello',
      '下午12:06\tAlice\tHi',
      '下午12:07\tBob\t[照片]',
    ].join('\n');
    const r = parser.parseAuto(t, {});
    assert.strictEqual(r.format, 'line');
    assert.strictEqual(r.messages.length, 3);
    assert.strictEqual(r.messages[0].sender, 'Bob');
    assert.ok(r.messages[0].ts.startsWith('2025-03-01T12:05'), 'pm 12:05 → 12:05');
    assert.strictEqual(r.messages[2].text, '[图片]');
  });
  await test('LINE TXT：官方 App 形态（发送者行 + 内容 + 独立时间行收尾）', () => {
    const t = [
      '[LINE] Alice',
      'Chat history with Bob',
      '2025.03.01 Monday',
      '',
      'Bob',
      'Hello',
      '',
      '下午12:05',
      '',
      'Alice',
      'Hi',
      '',
      '下午12:06',
    ].join('\n');
    const r = parser.parseAuto(t, {});
    assert.strictEqual(r.format, 'line');
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].sender, 'Bob');
    assert.strictEqual(r.messages[0].text, 'Hello');
  });
  await test('Telegram JSON：text 数组聚合 + service 消息跳过', () => {
    const j = JSON.stringify({
      name: 'Alice',
      messages: [
        { id: 1, type: 'message', date: '2025-03-01T12:00:00', from: 'Alice', text: ['你好，', { type: 'link', text: '链接' }] },
        { id: 2, type: 'service', date: '2025-03-01T12:01:00', action: ' joined the group' },
        { id: 3, type: 'message', date: '2025-03-01T12:02:00', from: 'Bob', text: '好的' },
      ],
    });
    const r = parser.parseAuto(j, {});
    assert.strictEqual(r.format, 'telegram');
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].text, '你好，链接');
    assert.strictEqual(r.messages[0].sender, 'Alice');
  });
  await test('Instagram JSON：乱码修复 + 逆序反转 + 媒体占位', () => {
    const j = JSON.stringify({
      participants: [{ name: 'Alice' }],
      messages: [
        { sender_name: 'Alice', timestamp_ms: 1735725600000, content: '\u00e4\u00bd\u00a0\u00e5\u00a5\u00bd' },
        { sender_name: 'Bob', timestamp_ms: 1735729200000, photos: [{ uri: 'x.jpg' }] },
        { sender_name: 'Bob', timestamp_ms: 1735732800000, content: '\u00e5\u00a5\u00bd\u00e7\u009a\u0084' },
      ],
    });
    const r = parser.parseAuto(j, {});
    assert.strictEqual(r.format, 'instagram');
    assert.strictEqual(r.messages.length, 3);
    assert.ok(r.messages[0].ts < r.messages[2].ts, '应为正序');
    assert.ok(r.messages[0].text.includes('你'), '乱码应修复为中文: ' + r.messages[0].text);
    assert.strictEqual(r.messages[1].text, '[图片]');
  });
  await test('Discord DCE JSON：guild+channel+messages', () => {
    const j = JSON.stringify({
      guild: { id: 'g', name: 'G' }, channel: { id: 'c', name: 'general' },
      messages: [{ id: '1', timestamp: '2025-03-01T12:00:00.000+08:00', author: { name: 'Alice' }, content: 'hello discord' }],
    });
    const r = parser.parseAuto(j, {});
    assert.strictEqual(r.format, 'discord');
    assert.strictEqual(r.messages[0].text, 'hello discord');
    assert.strictEqual(r.messages[0].sender, 'Alice');
  });
  await test('Discord DCE TXT：日期行 + 续行 + 分页符', () => {
    const t = '[01-Mar-25 12:44 PM] Alice\nhello there\n[01-Mar-25 12:45 PM] Bob\n\u001ahello!';
    const r = parser.parseAuto(t, {});
    assert.strictEqual(r.format, 'discord-txt');
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[0].sender, 'Alice');
    assert.strictEqual(r.messages[0].text, 'hello there');
  });
  await test('Google Chat Takeout：中英日期 + 上午下午', () => {
    const j = JSON.stringify({ messages: [
      { creator: { name: 'Alice' }, created_date: '2025年3月1日 UTC+8 下午7:02:13', text: '晚上好' },
      { creator: { name: 'Bob' }, created_date: 'Mar 1, 2025, 8:02:13 PM UTC+8', text: 'hey' },
    ] });
    const r = parser.parseAuto(j, {});
    assert.strictEqual(r.format, 'googlechat');
    assert.strictEqual(r.messages.length, 2);
    assert.ok(r.messages[0].ts.includes('11:02'), 'UTC+8 下午7点 = UTC 11 点: ' + r.messages[0].ts);
    assert.ok(r.messages[1].ts.includes('12:02'), 'UTC+8 的 20:02 → UTC 12:02: ' + r.messages[1].ts);
  });
  await test('iMessage 风格 CSV（is_from_me 列）', () => {
    const j = 'Date,Service,is_from_me,Text\n2025-03-01 12:00,SMS,0,hi\n2025-03-01 12:01,SMS,1,yo';
    const r = parser.parseAuto(j, { selfName: '' });
    assert.ok(['csv', 'discord-csv'].includes(r.format));
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[1].isSelf, true, 'is_from_me=1 应标记本人');
  });

  await test('深度分析追问：空问题报错；mock 追问返回 Markdown', async () => {
    const storeA = new Store();
    storeA.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-fu-')));
    const bA = storeA.createPerson('追问测试', '');
    let threw = false;
    try { await pipeline.analysisFollowUp(storeA, bA, SETTINGS, { digest: {}, history: [], question: '  ' }); } catch { threw = true; }
    assert.ok(threw, '空追问应报错');
    const r = await pipeline.analysisFollowUp(storeA, bA, SETTINGS, { digest: { stats: {} }, history: [{ q: '之前问过什么', a: '之前的回答' }], question: 'TA 为什么回避冲突？' });
    assert.ok(r.answer.includes('##'), '追问回答应为 Markdown');
    storeA.deletePerson(bA.id);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) { for (const f of failures) console.log('FAIL', f.name, f.err.stack); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
