'use strict';
/**
 * 批次调试（一次性工具）：按真实分片复现某一批的原始返回，用于排查
 * 「applied: 0」与「模型返回内容为空」这类静默异常。
 *
 * 用法：node tools/debug-batch.js --batch=2 [--json]
 */

const fs = require('fs');

const BOARD_NAME = {
  society: '社会民生',
  ent: '娱乐',
  tech: '科技数码',
  finance: '财经商业',
  sports: '体育竞技',
  world: '国际时政',
  life: '生活种草',
  health: '健康养生',
  other: '其他',
};
const BOARD_LIST_TEXT = Object.entries(BOARD_NAME).map(([id, n]) => `${id}=${n}`).join('，');
const SYSTEM_CLASSIFY = [
  '你是中文内容分类助手。把每条内容归入下列九个板块之一：',
  BOARD_LIST_TEXT,
  '',
  '边界规则（重要）：',
  '1. 娱乐（ent）是合并板块：明星艺人八卦、影视剧、综艺节目、纪录片、动漫、颁奖（飞天/金鸡/白玉兰等）、',
  '   票房、收视、剧集与节目讨论，全部归 ent。不设内部细分。',
  '2. 娱乐 vs 生活：普通人分享旅行/美食/穿搭/日常，归 life；涉及明星、演员、剧综作品、饭圈，归 ent。',
  '3. 娱乐 vs 社会：以「当事人是公众人物」为主 → ent；以「司法/通报/事故/公共政策」为主 → society。',
  '4. 只看内容讲的是什么，不要被「热搜」「官宣」「疑似」这类体裁词带偏。',
  '5. 确实无法归类的用 other，不要硬猜。',
  '',
  '输入里每条带一个 suggested 字段，是规则给出的初步判断。若你认为它明显错误就给出你的判断，',
  '否则沿用 suggested。同时给出你的把握程度：high（确定）/ low（不确定）。',
  '只输出 JSON 数组，形如 [{"key":"条目的key","board":"板块id","confidence":"high|low"}]，不要输出任何解释。',
].join('\n');

const BATCH_SIZE = 25;
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : d;
};

const FILE = arg('file', 'hotspot-daily/data/digest/2026-10-10.json');
const want = Number(arg('batch', 2));

const digest = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const seen = new Set();
const all = [];
const push = (it) => {
  if (!it || !it.key || seen.has(it.key)) return;
  seen.add(it.key);
  all.push(it);
};
for (const t of digest.top10 || []) push(t);
for (const b of digest.boards || []) for (const it of b.items || []) push(it);

const batch = all.slice((want - 1) * BATCH_SIZE, want * BATCH_SIZE);
const payload = batch.map((it) => {
  const row = { key: it.key, title: it.title, suggested: it.board || 'other' };
  const intro = String(it.desc || it.content || '').trim();
  if (intro) row.intro = intro.slice(0, 60);
  return row;
});
const user = `请为下列 ${payload.length} 条内容判定板块：\n${JSON.stringify(payload)}`;

const key = process.env.HOTSPOT_AI_KEY;
const base = process.env.HOTSPOT_AI_BASE_URL || 'https://api.deepseek.com/v1';
const model = process.env.HOTSPOT_AI_MODEL || 'deepseek-flash';

(async () => {
  console.log(`[dbg] batch=${want} 条数=${batch.length} user字符=${user.length}`);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_CLASSIFY },
        { role: 'user', content: user },
      ],
    }),
  });
  const text = await res.text();
  const j = JSON.parse(text);
  const ch = (j.choices || [])[0] || {};
  const content = (ch.message && ch.message.content) || '';
  console.log('[dbg] finish_reason=' + ch.finish_reason + ' usage=' + JSON.stringify(j.usage));
  console.log('[dbg] content 前 200 字：' + JSON.stringify(content.slice(0, 200)));
  console.log('[dbg] content 长度=' + content.length);
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.log('[dbg] 直接 JSON.parse 失败：' + e.message);
  }
  if (parsed) {
    console.log('[dbg] 顶层类型=' + (Array.isArray(parsed) ? 'array' : typeof parsed));
    if (!Array.isArray(parsed)) console.log('[dbg] 顶层键=' + JSON.stringify(Object.keys(parsed)));
  }
})();
