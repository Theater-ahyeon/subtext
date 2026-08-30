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
const { extractJson, normalizeBaseUrl } = require('../src/main/llm');

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
  await test('compileCard：Q24 防误读按句边界截断且跳过"不知道"', () => {
    const b1 = store.createPerson('Q24a', '');
    b1.interview.records[24] = { qid: 24, question: '', answer: '不知道', probeAnswer: '', note: '' };
    assert.ok(!P.compileCard(b1).includes('防误读重点'));
    const b2 = store.createPerson('Q24b', '');
    b2.interview.records[24] = { qid: 24, question: '', answer: '别把她写成高冷。她话少是因为谨慎。' + '很长的补充。'.repeat(60), probeAnswer: '', note: '' };
    const card2 = P.compileCard(b2);
    assert.ok(card2.includes('防误读重点'));
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
    assert.throws(() => extractJson('完全没有JSON'));
  });
  await test('normalizeBaseUrl', () => {
    assert.strictEqual(normalizeBaseUrl('https://x.com'), 'https://x.com/v1/chat/completions');
    assert.strictEqual(normalizeBaseUrl('https://x.com/v1'), 'https://x.com/v1/chat/completions');
    assert.strictEqual(normalizeBaseUrl('https://x.com/v1/chat/completions/'), 'https://x.com/v1/chat/completions');
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
    const report = await pipeline.endSession(store2, bundle, SETTINGS, session.id);
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
    try { await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: pred.id, raw: '再交一次' }); } catch (e) { threw = /已归因/.test(e.message); }
    assert.ok(threw, '重复归因应被拒绝');
    let threw2 = false;
    try { await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: 'not-exists', raw: 'x' }); } catch { threw2 = true; }
    assert.ok(threw2, '无效预测单应报错');
  });
  await test('归因撤销：恢复卡片到归因前状态', async () => {
    const { session } = await pipeline.startSession(store2, bundle, SETTINGS, '撤回测试');
    const pred = await pipeline.freezePrediction(store2, bundle, SETTINGS, session.id);
    const nBefore = bundle.claims.length;
    const { record } = await pipeline.submitFeedback(store2, bundle, SETTINGS, { predictionId: pred.id, raw: '她主动帮我了' });
    const added = record.updates.filter(u => u.action === 'add').length;
    const reverted = pipeline.undoAttribution(store2, bundle, record.id);
    assert.strictEqual(bundle.claims.length, nBefore, '撤销后应恢复条目数');
    assert.strictEqual(bundle.predictions.find(p => p.id === pred.id).status, 'open', '预测单应回到待回流');
    let threw = false;
    try { pipeline.undoAttribution(store2, bundle, record.id); } catch { threw = true; }
    assert.ok(threw, '不能重复撤销');
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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) { for (const f of failures) console.log('FAIL', f.name, f.err.stack); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
