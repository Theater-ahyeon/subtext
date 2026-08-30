'use strict';
/**
 * 提示词构建：AIRP 人物生境写法的产品化落地。
 * 核心纪律：
 *  - 生境卡是最小生成条件，不是全量画像：空白层不进卡、可过期信息只进动态状态
 *  - 写倾向不写唯一答案（往往/容易/更愿意），标签必须附带行为含义
 *  - 推断可溯源（证据编号 / 用户陈述 / AI 推断），不脑补
 *  - 心理输出=行为推测，禁止临床诊断；拒绝操控类请求（硬过滤 + 提示词双保险）
 */

const LAYER_NAMES = { basic: '基础信息', life: '生活结构', temperament: '人物性情', expression: '场景表达' };
const EPISTEMIC_NAMES = { fact: '事实', inference: '推断', blank: '空白' };
const SOURCE_NAMES = { evidence: '证据支持', user: '用户陈述', ai: 'AI推断' };

/** 组装生境卡文本（用于 LLM 注入）。空白层不进卡。 */
function compileCard(bundle, { includeDynamic = true } = {}) {
  const parts = [];
  parts.push(`<生境卡：${bundle.name}${bundle.alias ? '(' + bundle.alias + ')' : ''}>`);
  for (const layer of ['basic', 'life', 'temperament', 'expression']) {
    const claims = bundle.claims
      .filter(c => c.layer === layer && c.epistemic !== 'blank')
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 12);
    if (!claims.length) continue; // AIRP：没有独立内容的可选部分连同标签一起删去
    parts.push(`【${LAYER_NAMES[layer]}】`);
    for (const c of claims) parts.push('- ' + c.text);
  }
  if (includeDynamic) {
    const dyn = bundle.dynamic.filter(d => !d.resolved).slice(-6);
    if (dyn.length) {
      parts.push('【动态状态】（近期情况，可能已过时，以最新对话为准）');
      for (const d of dyn) parts.push('- ' + d.text);
    }
  }
  // 防误读规则（来自 24 问 Q24，若访谈已完成）
  if (bundle.interview && bundle.interview.records && bundle.interview.records[24]) {
    const r = bundle.interview.records[24];
    const text = (r.answer || '') + (r.probeAnswer ? '；' + r.probeAnswer : '');
    if (text.trim()) {
      parts.push('【防误读重点】（用户明确要求，违反即失真）');
      parts.push('- ' + text.trim().slice(0, 300));
    }
  }
  parts.push('</生境卡>');
  return parts.join('\n');
}

/** 演练 twin 的 system prompt */
function twinSystemPrompt(bundle, scenario) {
  return [
    '你是"数字孪生演练"引擎，正在真实地扮演一位真实人物，帮助用户在低风险环境中演练重要对话，这不是虚构写作。',
    '',
    compileCard(bundle),
    '',
    '演绎要求：',
    '- 生境卡是生成条件而非台词库。不要复述卡片、不要复读固定动作，以她已有的生活、在意与表达方式面对眼前情境自然回应。',
    '- 写倾向不写唯一答案：同一类情境允许不同反应，但始终是同一个人。',
    `- 她不只在回应 ${'用户'}：她有自己的事情、注意与行动线。她可以自然地沉默、转移话题、追问、拒绝、提出自己的需求。`,
    '- 回复使用她的口吻说话，动作神态可用括号简短描述；不要内心独白；不要输出心理分析。',
    '- 回复保持日常对话体量，通常 1~5 句，除非情境确实需要更长。',
    scenario ? `\n【演练场景】${scenario}\n由你先自然开场。` : '\n由你自然开场。',
    '',
    '安全边界（最高优先级）：',
    '- 若用户要求操控、打压、欺骗或伤害对方的策略，立即退出角色，用[系统提示]开头说明：本工具只辅助理解与表达，不提供操控策略；然后给出一个"诚实表达自己需求"方向的建议。',
    '- 不输出任何临床心理诊断或疾病标签。',
    '- 不要替用户预判"她一定怎么想"，那是归纳器的职责。',
  ].join('\n');
}

/** 证据归纳 → 生境卡初稿 */
function inductionPrompt(bundle, evidenceLines, existingSummaries) {
  return [
    'TASK:INDUCE',
    '你是人物生境归纳器。下面是关于一位真实人物的原始素材片段（编号 E*，可能包含聊天记录、动态、访谈记录）。',
    '你的任务：按 AIRP 人物生境写法归纳出"最小而可生成"的人物认知条目。',
    '',
    '硬性规则：',
    '1. 只写素材支持的条目，每条必须引用证据编号（如 refs:["E3"]）。没有素材支持的，不要写。',
    '2. 层次只允许四种：basic(基础信息：身份/关系/外貌锚点等不失效事实)、life(生活结构：长期投入的事、责任、场所、现实限制)、temperament(人物性情：她怎样理解事情、真正在意什么、倾向)、expression(场景表达：消息节奏、句式、表达体量、情绪的来路与经过)。',
    '3. epistemic（认识层级）：fact=素材明确发生过的；inference=由素材做出的长期倾向推断。不确定的不要编。',
    '4. 性情条目用倾向措辞（往往/容易/更愿意/很难），禁止"永远/绝不"，禁止临床诊断标签（如抑郁、NPD），标签词必须附带在她身上的具体含义。',
    '5. 只与"对你"互动相关的行为，要标注场景局限，不要泛化成她的全部性格。',
    '6. 另输出 blanks：素材中明显缺失、值得了解的生境信息（3~6 条）。',
    '7. 输出 JSON：{"claims":[{"layer","text","epistemic","refs","confidence"(0~1)}],"blanks":["..."]}',
    existingSummaries ? `\n已归纳过的条目（不要重复，若素材矛盾可在 text 中用"但/近期"体现）：\n${existingSummaries}` : '',
    `\n素材片段：\n${evidenceLines.join('\n')}`,
  ].filter(Boolean).join('\n');
}

/** 演练复盘报告 */
function reviewPrompt(bundle, transcript) {
  return [
    'TASK:REVIEW',
    '你是社交演练复盘教练。用户刚与一位真实人物的数字孪生完成一场演练。请输出复盘报告（Markdown，中文）。',
    '',
    compileCard(bundle),
    '',
    '报告固定结构，标题用 ## / ###：',
    '## 一、孪生演绎质量 —— 按六个观察逐条评（连续性/变化性/迁移能力/独立性/时间连续/成长能力），指出本轮扮演哪里符合生境卡、哪里失真。',
    '## 二、你的沟通复盘 —— 指出用户哪些表达有效、哪些可能被误解、哪些信号被错过；只基于对话文本，不臆测。',
    '## 三、下轮演练建议 —— 1~3 条具体的、可练习的行为。',
    '## 四、现实验证清单 —— 基于生境卡缺失/空白处，列出下次与真人互动时可自然验证的问题。',
    '语气：具体、直接、不奉承。禁止操控类建议，禁止临床标签。',
    '',
    `演练对话记录：\n${transcript}`,
  ].join('\n');
}

/** 预测单冻结：多假设推断 */
function hypothesisPrompt(bundle, transcript) {
  return [
    'TASK:HYPOTHESIS',
    '你是心理假设引擎（行为推测，非诊断）。基于生境卡与演练记录，生成关于"她现实中可能如何回应"的多假设预测单，用于之后与她的真实反应对照校准。',
    '规则：',
    '- 2~4 个假设，prob 之和约等于 1；每个假设带 basis（引用生境卡或对话中的依据）与 verify（下次互动中如何验证）。',
    '- 用倾向措辞，禁止临床标签，禁止唯一答案式断言。',
    '- expected：一段话概括最可能的反应形态（内容方向+表达形态，不预写台词）。',
    '输出 JSON：{"hypotheses":[{"text","prob","basis","verify"}],"expected":"..."}',
    '',
    compileCard(bundle),
    '',
    `演练记录：\n${transcript}`,
  ].join('\n');
}

/** 差异归因 */
function attributionPrompt(bundle, prediction, realResponse, transcript) {
  return [
    'TASK:ATTRIBUTION',
    '你是差异归因引擎。用户曾冻结一份关于"她"的预测单，现在发来了她在现实中的真实反应。请对照归因，并生成对生境卡的结构化更新建议。',
    '规则：',
    '- verdict 只允许：hit(命中)/partial(方向对但形态偏)/miss(假设全落空)/fact-error(事实层错误)/material-missing(材料缺失导致套模板)/temperament-error(性情推断错)/expression-error(表达形态不像她)。',
    '- analysis：对照说明哪里对哪里错、为什么（引用预测假设编号与生境卡条目），承认不确定性。',
    '- updates：对生境卡的最小修正建议，action 只允许 add(新增条目)/update(改写现有条目，需给 claimId)/deprecate(标记某条不可靠，需给 claimId)；每条给 reason。不重写整卡，不做无关扩充。',
    '- 禁止临床标签；推测措辞用倾向词。',
    '输出 JSON：{"verdict","analysis","updates":[{"action","claimId"(可选),"layer"(add时必填),"text","reason"}]}',
    '',
    compileCard(bundle),
    prediction ? `\n【预测单（冻结于真实反应之前）】\n${JSON.stringify({ hypotheses: prediction.hypotheses, expected: prediction.expected }, null, 2)}` : '\n（无预测单：本次为直接现实回流，仅基于生境卡与对话做归因）',
    transcript ? `\n【演练/近期对话】\n${transcript}` : '',
    `\n【她的真实反应】\n${realResponse}`,
  ].filter(Boolean).join('\n');
}

// ---------------- 24问访谈（人物观察版） ----------------

const INTERVIEW_QUESTIONS = [
  { qid: 1, group: '第一组：认识她', text: '你对她最原始的印象是什么？可以是一种感觉、一个画面或一个瞬间——不必是性格词。', hint: '什么东西删掉以后，她就不像她了？' },
  { qid: 2, group: '第一组：认识她', text: '她最让你在意、或最吸引你继续观察的地方是什么？这种吸引力来自哪种稳定的特质？', hint: '不要停在"漂亮/温柔/厉害"，试着指出一个稳定的张力。' },
  { qid: 3, group: '第一组：认识她', text: '你最不希望别人怎样误解她？为什么那样的理解是错的？', hint: '写清"这个解释错在哪里"，这是她的人格边界。' },
  { qid: 4, group: '第一组：认识她', text: '如果只能保留一个核心特质来解释她的大部分选择，会是什么？', hint: '追求解释力，不追求漂亮的词。' },
  { qid: 5, group: '第一组：认识她', text: '这个核心特质最常见、最稳定的表现是什么？', hint: '先找最常见的表现，不要一次列很多标签。' },
  { qid: 6, group: '第一组：认识她', text: '用这个核心特质解释刚才的表现，都解释得通吗？它还能解释她的哪些其他行为？', hint: '如果解释不通，要么核心需要修正，要么那个表现另有来源。' },
  { qid: 7, group: '第二组：分化与反向', text: '这个核心特质是通过什么机制变成那些具体表现的？', hint: '格式："因为她是……，当她面对……时，就会……"' },
  { qid: 8, group: '第二组：分化与反向', text: '哪些具体表现还能继续向下拆解出更细的稳定倾向？', hint: '不是所有特质都要无限拆分，能解释更多行为的优先。' },
  { qid: 9, group: '第二组：分化与反向', text: '她有没有看起来和核心特质相反的表现？通常在什么情况下出现？', hint: '先描述，不急着解释来源。' },
  { qid: 10, group: '第二组：分化与反向', text: '这个"相反"的表现能追溯到核心特质的极端化吗？还是另有独立的来源？', hint: '三种可能：核心极端化 / 独立来源 / 其实不矛盾。' },
  { qid: 11, group: '第二组：分化与反向', text: '回顾一下：哪些特质值得继续拆解，哪些暂时只能停留在标签？', hint: '承认"暂时是标签"是完全合法的。' },
  { qid: 12, group: '第三组：信念与认知', text: '她自己清楚说出过、用来指导行动的准则是什么？', hint: '格式通常是"如果……就应该……""……的人才值得……"' },
  { qid: 13, group: '第三组：信念与认知', text: '面对事情本身（不涉及具体的人）时，她最容易冒出的第一判断是什么？', hint: '例如面对失败、面对未知、面对自己的能力。' },
  { qid: 14, group: '第三组：信念与认知', text: '当别人的行为可以有多种解释时，她倾向于选择哪种解释？', hint: '善意/恶意？归到自己还是对方？暂时还是持久？' },
  { qid: 15, group: '第三组：信念与认知', text: '她有哪些稳定的"错误规则"或绝对化判断？', hint: '"我必须……""别人一定……""如果……就说明……"' },
  { qid: 16, group: '第三组：信念与认知', text: '她最深、可能连自己都不愿承认的信念是什么？', hint: '追问：为什么这些准则对她如此重要？如果答不出更深层的，"确认无更深层"也是合法答案。' },
  { qid: 17, group: '第四组：情绪反应', text: '日常中，哪一类事情最容易让她起情绪波动？', hint: '是反复出现的一类触发，不是一次极端事件。' },
  { qid: 18, group: '第四组：情绪反应', text: '面对这类事，她第一时间怎么解释它——她认为发生了什么？', hint: '先写她的理解，不直接写"她会生气"。' },
  { qid: 19, group: '第四组：情绪反应', text: '这种解释会带来什么情绪、身体反应或状态？', hint: '情绪要与前面的解释连接起来。' },
  { qid: 20, group: '第四组：情绪反应', text: '这种状态最终会把她推向什么决定和行为？', hint: '不停在"她很生气"，写到她选择做什么。' },
  { qid: 21, group: '第五组：循环与决策', text: '这些行为给她带来什么短期收益，又造成什么长期代价？', hint: '短期收益解释行为为什么持续，长期代价解释矛盾从哪来。' },
  { qid: 22, group: '第五组：循环与决策', text: '这些结果会怎样反过来强化或动摇她原来的信念？', hint: '这是认知-行为循环的闭环。' },
  { qid: 23, group: '第五组：循环与决策', text: '在亲密关系、冲突和压力下，她最稳定的决策逻辑是什么？', hint: '什么让她坚持？什么能让她退让？什么比她的利益更重要？' },
  { qid: 24, group: '第五组：循环与决策', text: '如果让 AI 在陌生情境里扮演她，最容易写错什么？正确的判断依据是什么？', hint: '这条会直接成为孪生的防误读护栏。' },
];

function interviewSystemPrompt() {
  return [
    '你是人物生境访谈员，正通过 24 个正式问题帮助用户整理他对一位真实人物的观察与理解。',
    '规则：',
    '- 你只提问、追问、记录、归纳、指出逻辑冲突；不替用户决定未知内容，不把推测写成事实。',
    '- 用户给出抽象标签（温柔/傲娇/缺爱等）时，追问具体行为表现："具体会怎么做？""为什么这是她的，而不是普通人的礼貌？"',
    '- 用户回答矛盾时，检查是否属于不同情境/层级/反向展开，不急于判定谁对。',
    '- 用户说"不知道/跳过"，记录为暂未确定，不要编造。',
    '- 禁止临床诊断标签；禁止为了显得深刻而强加创伤或矛盾。',
    '- 输出只包含要问的下一个问题或被要求的整理结果，保持简短。',
  ].join('\n');
}

function interviewProbePrompt(qid, question, answer, recordsDigest) {
  return [
    'TASK:INTERVIEW_PROBE',
    interviewSystemPrompt(),
    '',
    `当前问题 Q${qid}：${question}`,
    recordsDigest ? `已记录的其他要点（供参考避免重复追问）：\n${recordsDigest}` : '',
    `\n用户回答：「${answer}」`,
    '',
    '判断：若回答已具体（有可落地的行为/事件/解释），输出"OK"（仅两个字母）。若偏抽象标签或需要澄清，输出一个追问（只一个问题，中文，针对"具体表现"或"为什么"）。',
  ].join('\n');
}

function interviewSummaryPrompt(recordsDigest) {
  return [
    'TASK:INTERVIEW_SUMMARY',
    '基于以下 24 问访谈记录，输出中途小结（Markdown）：已确定的核心特质 / 已确定的倾向与衍生 / 已出现的反向表现 / 已触及的信念 / 情绪ABC循环（如有） / 当前未解决的矛盾 / 下一步建议方向。区分"用户确定"与"你的推论"，不知道的留白。',
    '',
    recordsDigest,
  ].join('\n');
}

function interviewFinalPrompt(recordsDigest) {
  return [
    'TASK:INTERVIEW_FINAL',
    '基于以下 24 问访谈记录，输出最终整合。输出 JSON：',
    '{"final":"完整 Markdown 整合文本（结构：一、用户已经确定的内容；二、核心特质及其解释力；三、特质层级树（含反向特质来源标注）；四、信念与认知分层；五、情绪ABC循环；六、认知-行为循环；七、压力/冲突/亲密下的决策逻辑；八、容易出现的反向表现；九、AI防误读重点；十、高可能推论；十一、仍待确认的问题）",',
    ' "suggestions":[{"layer":"basic|life|temperament|expression","text":"...","kind":"fact|inference"}]}',
    'suggestions 是建议写入生境卡的条目（6~14 条）：kind=fact 仅限用户明确确定的事实；推论一律 kind=inference。text 使用倾向措辞，禁止临床标签，每条 ≤60 字。',
    '',
    recordsDigest,
  ].join('\n');
}

// ---------------- 红线守卫 ----------------

const REDLINE_PATTERNS = [
  /pua/i, /操控/, /操纵/, /控制她/, /让她听话/, /服从性/, /驯化/, /打压/, /贬低她/, /冷读/, /推拉话术/, /煤气灯/, /gaslight/i, /精神控制/, /情感勒索/, /孤立她/, /套路她/, /下頭位/, /下头话术/, /钓鱼执法|查手机|监控她|跟踪/,
];

function redlineCheck(text) {
  if (!text) return false;
  return REDLINE_PATTERNS.some(re => re.test(text));
}

module.exports = {
  LAYER_NAMES, EPISTEMIC_NAMES, SOURCE_NAMES, INTERVIEW_QUESTIONS,
  compileCard, twinSystemPrompt, inductionPrompt, reviewPrompt,
  hypothesisPrompt, attributionPrompt,
  interviewSystemPrompt, interviewProbePrompt, interviewSummaryPrompt, interviewFinalPrompt,
  redlineCheck, REDLINE_PATTERNS,
};
