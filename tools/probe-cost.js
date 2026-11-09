'use strict';
/**
 * 成本探针（一次性工具）：用真实成稿里的 N 条数据，实测「终审批次」的 token 消耗。
 * 用途：在正式跑全量终审前，判断 BATCH_SIZE / effort 是否合理，避免撞 max_tokens 或超预算。
 *
 * 用法：node tools/probe-cost.js --n=25 [--effort=low] [--file=<digest.json>]
 */

const fs = require('fs');
const path = require('path');

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

const BOARD_LIST_TEXT = Object.entries(BOARD_NAME)
  .map(([id, name]) => `${id}=${name}`)
  .join('，');

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

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const N = Number(arg('n', 25));
const FILE = arg('file', 'hotspot-daily/data/digest/2026-10-10.json');
const EFFORTS = arg('effort', '');

const digest = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// 复刻 collectAllForReview
const seen = new Set();
const all = [];
const push = (it) => {
  if (!it || !it.key || seen.has(it.key)) return;
  seen.add(it.key);
  all.push(it);
};
for (const t of digest.top10 || []) push(t);
for (const b of digest.boards || []) for (const it of b.items || []) push(it);

const batch = all.slice(0, N);
const payload = batch.map((it) => {
  const row = { key: it.key, title: it.title, suggested: it.board || 'other' };
  const intro = String(it.desc || it.content || '').trim();
  if (intro) row.intro = intro.slice(0, 60);
  return row;
});
const user = `请为下列 ${payload.length} 条内容判定板块：\n${JSON.stringify(payload)}`;

console.log(`[probe] 成稿共 ${all.length} 条，本批 ${batch.length} 条`);
console.log(`[probe] system 字符 ${SYSTEM_CLASSIFY.length}，user 字符 ${user.length}`);

const key = process.env.HOTSPOT_AI_KEY || '';
const base = process.env.HOTSPOT_AI_BASE_URL || 'https://api.deepseek.com/v1';
const model = process.env.HOTSPOT_AI_MODEL || 'deepseek-flash';

async function one(effort) {
  const body = {
    model,
    temperature: 0.4,
    max_tokens: 8192,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_CLASSIFY },
      { role: 'user', content: user },
    ],
  };
  if (effort) body.effort = effort;
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.log(`[probe] effort=${effort || '(default)'} HTTP ${res.status} ${text.slice(0, 300)}`);
    return null;
  }
  const u = j.usage || {};
  const fin = j.choices && j.choices[0] && j.choices[0].finish_reason;
  const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  let arr = null;
  try {
    arr = JSON.parse(content);
  } catch {}
  console.log(
    `[probe] effort=${String(effort || '(default)').padEnd(9)} prompt=${u.prompt_tokens} completion=${u.completion_tokens}` +
      ` reasoning=${(u.completion_tokens_details || {}).reasoning_tokens} finish=${fin} 返回条数=${Array.isArray(arr) ? arr.length : 'X'} ${ms}ms`
  );
  return u;
}

(async () => {
  if (!key) {
    console.log('[probe] 缺少 HOTSPOT_AI_KEY');
    process.exit(1);
  }
  const list = EFFORTS ? EFFORTS.split(',') : ['low'];
  for (const e of list) await one(e === 'default' ? '' : e);
  // 余额
  try {
    const r = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const b = await r.json();
    console.log('[probe] 余额 ' + JSON.stringify(b.balance_infos));
  } catch (err) {
    console.log('[probe] 余额查询失败 ' + err.message);
  }
})();
