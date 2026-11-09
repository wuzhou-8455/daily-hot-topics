'use strict';

/**
 * 离线重建某一天的成稿（digest）。
 *
 * 用途：改了分类规则（词表 / 板块划分 / 打分）之后，不用重新联网抓一遍，
 * 直接拿当天的原始快照 data/raw/<date>.json 重算成稿。
 *
 * ⚠️ 为什么不能只调 buildDigest：`serialize()` 把 deepRead 写死为 null，
 * 而 deepRead 是模型花钱生成的；同理「模型终审」判过的板块（boardSource==='ai'）
 * 也是花过钱的。重建时这两样必须从旧成稿搬回来，否则一次重建就永久损失。
 *
 * 用法：
 *   node tools/rebuild-digest.js                       # 今天，默认数据目录
 *   node tools/rebuild-digest.js --date=2026-10-10
 *   node tools/rebuild-digest.js --data=C:/path/to/data
 *   node tools/rebuild-digest.js --dry                 # 只报告，不写盘
 */

const fs = require('fs');
const path = require('path');

const classifier = require('../src/main/classifier');

/** 已废弃的板块 id → 现役板块 id（板块合并后旧成稿里会残留） */
const LEGACY_BOARD = { screen: 'ent' };
const BOARD_NAME = require('../src/shared/constants').BOARD_NAME;

function todayCst() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const out = { data: '', date: '', dry: false };
  for (const a of argv) {
    if (a.startsWith('--data=')) out.data = a.slice('--data='.length);
    else if (a.startsWith('--date=')) out.date = a.slice('--date='.length);
    else if (a === '--dry') out.dry = true;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function boardStats(digest) {
  const src = {};
  const conf = {};
  const items = [...(digest.top10 || []), ...(digest.boards || []).flatMap((b) => b.items || [])];
  for (const it of items) {
    src[it.boardSource] = (src[it.boardSource] || 0) + 1;
    conf[it.confidence || '(无字段)'] = (conf[it.confidence || '(无字段)'] || 0) + 1;
  }
  return { src, conf, other: (digest.boards || []).find((b) => b.id === 'other'), items };
}

/** 整份成稿里带解读的条目数（含被挤出 Top10、落进板块列表的那些） */
function deepReadTotal(digest) {
  return [...(digest.top10 || []), ...(digest.boards || []).flatMap((b) => b.items || [])].filter(
    (it) => it.deepRead,
  ).length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = args.data || path.join(process.env.APPDATA || '', 'hotspot-daily', 'data');
  const date = args.date || todayCst();

  const rawPath = path.join(dataRoot, 'raw', `${date}.json`);
  const digestPath = path.join(dataRoot, 'digest', `${date}.json`);
  const prevPath = path.join(dataRoot, 'digest', `${classifier.shiftDateKey(date, -1)}.json`);

  console.log(`[rebuild] 数据目录 ${dataRoot}`);
  console.log(`[rebuild] 日期      ${date}`);

  const raw = readJson(rawPath);
  if (!raw || !Array.isArray(raw.sources)) {
    console.error(`[rebuild] 找不到原始快照：${rawPath}（没有 raw 就无法离线重建）`);
    process.exit(1);
  }

  const old = readJson(digestPath);
  const prevDigest = readJson(prevPath);

  const next = classifier.buildDigest({
    date: raw.date || date,
    sourceResults: raw.sources,
    fetchedAt: raw.fetchedAt,
    prevDigest,
  });

  /* ---------- 从旧成稿搬回「花过钱」的东西 ---------- */

  let deepReadRestored = 0;
  let boardKept = 0;

  if (old) {
    const oldItems = new Map();
    for (const it of old.top10 || []) oldItems.set(it.key, it);
    for (const b of old.boards || []) for (const it of b.items || []) oldItems.set(it.key, it);

    const carry = (target) => {
      const o = oldItems.get(target.key);
      if (!o) return;
      // 1) 模型写的解读
      if (o.deepRead && !target.deepRead) {
        target.deepRead = o.deepRead;
        deepReadRestored += 1;
      }
      // 2) 模型终审定的板块（规则重算会把它冲掉，但那是花了 token 的结果）
      if (o.boardSource === 'ai' && o.board) {
        const id = LEGACY_BOARD[o.board] || o.board;
        if (BOARD_NAME[id]) {
          target.board = id;
          target.boardName = BOARD_NAME[id];
          target.boardSource = 'ai';
          target.confidence = o.confidence || 'high';
          boardKept += 1;
        }
      }
      // 3) 涨跌标记：没有昨日成稿时规则会把全部标成「新」，沿用旧值更准
      if (o.badge && !prevDigest) target.badge = o.badge;
    };

    for (const t of next.top10) carry(t);
    for (const b of next.boards) for (const it of b.items) carry(it);
    // 保持旧 order 语义：top10 标记不能被搬动
    if (old.ai) next.ai = old.ai;

    // 搬完可能有的条目换了板块，按新板块重新分组
    const flat = [];
    for (const b of next.boards) for (const it of b.items) flat.push(it);
    const grouped = new Map();
    for (const it of flat) {
      if (!grouped.has(it.board)) grouped.set(it.board, []);
      grouped.get(it.board).push(it);
    }
    next.boards = [...grouped.entries()]
      .map(([id, items]) => ({
        id,
        name: BOARD_NAME[id] || '其他',
        items: items.map((it, i) => ({ ...it, rank: i + 1 })),
      }))
      .sort((a, b) => b.items.length - a.items.length);

    // allItems 跟着对齐
    const byKey = new Map(flat.map((it) => [it.key, it]));
    for (const t of next.top10) byKey.set(t.key, t);
    if (Array.isArray(next.allItems)) {
      for (const it of next.allItems) {
        const hit = byKey.get(it.key);
        if (hit) it.board = hit.board;
      }
    }
    next.stats.boards = next.boards.length;
  }

  /* ---------- 报告 ---------- */

  const before = old ? boardStats(old) : null;
  const after = boardStats(next);
  console.log(`\n[rebuild] 板块数 ${next.boards.length}（旧 ${old ? old.boards.length : '-'}）`);
  console.log(
    `[rebuild] 板块分布 ${next.boards.map((b) => `${b.name} ${b.items.length}`).join(' / ')}`,
  );
  console.log(`[rebuild] boardSource ${JSON.stringify(after.src)}`);
  console.log(`[rebuild] confidence  ${JSON.stringify(after.conf)}`);
  if (before) {
    console.log(`[rebuild] 旧 boardSource ${JSON.stringify(before.src)}`);
    console.log(
      `[rebuild] 「其他」${before.other ? before.other.items.length : 0} → ${after.other ? after.other.items.length : 0} 条`,
    );
  }
  console.log(`[rebuild] 搬回解读 ${deepReadRestored} 条；沿用模型判定板块 ${boardKept} 条`);

  // Top10 成员变化：板块合并会改变「按板块轮转」的抽取结果，这是预期的，但要报出来
  if (old) {
    const oldTopKeys = new Set((old.top10 || []).map((t) => t.key));
    const newTopKeys = new Set(next.top10.map((t) => t.key));
    const left = [...oldTopKeys].filter((k) => !newTopKeys.has(k));
    const joined = [...newTopKeys].filter((k) => !oldTopKeys.has(k));
    const noRead = next.top10.filter((t) => !t.deepRead).length;
    if (left.length || joined.length) {
      console.log(
        `[rebuild] Top10 成员变化：换出 ${left.length} 条 / 换入 ${joined.length} 条` +
          (noRead ? `（其中 ${noRead} 条新进 Top10 的还没有解读，重新生成解读即可补上）` : ''),
      );
    }
  }

  // 断言
  const problems = [];
  if (next.boards.some((b) => b.id === 'screen')) problems.push('仍存在废弃板块 screen');
  if (after.src.prior) problems.push(`出现了 prior 兜底 ${after.src.prior} 条（fallbackPriors 应为空）`);
  // 解读按「整份成稿」计量：被挤出 Top10 的那些条目，解读仍保留在板块列表里
  const oldDeep = old ? deepReadTotal(old) : 0;
  const newDeep = deepReadTotal(next);
  if (newDeep < oldDeep) problems.push(`解读丢失：旧 ${oldDeep} 条 → 新 ${newDeep} 条`);

  if (problems.length) {
    console.error('\n[rebuild] ❌ 自检未通过：');
    for (const p of problems) console.error('   - ' + p);
    process.exitCode = 1;
    return;
  }
  console.log('[rebuild] ✅ 自检通过');

  if (args.dry) {
    console.log('[rebuild] --dry 模式，未写盘');
    return;
  }

  if (old) {
    fs.copyFileSync(digestPath, `${digestPath}.bak`);
    console.log(`[rebuild] 旧文件已备份为 ${path.basename(digestPath)}.bak`);
  }
  fs.writeFileSync(digestPath, JSON.stringify(next, null, 2), 'utf8');
  console.log(`[rebuild] 已写入 ${digestPath}`);
}

main();
