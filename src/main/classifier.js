'use strict';

const fs = require('fs');
const path = require('path');
const { BOARD_NAME } = require('../shared/constants');
const { isoCst, dateKey } = require('./time');

/**
 * 把各平台原始榜单整理成一份成稿：
 *   标题归一化 → 跨平台聚类（同一事件合并） → 热度加权打分 → 九板块分类 → 去同质化选 Top10 → 涨跌标记
 *
 * 全部为规则实现：确定、可复现、零模型成本。模型只负责后续写解读与长尾归类。
 */

const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'boards.json'), 'utf8'),
);

const JACCARD_THRESHOLD = 0.42;
const CONTAINMENT_MIN_LEN = 5;
const TOP_N = 10;
const BOARD_CAP = 3;

/* ---------------- 标题归一化 ---------------- */

function normalizeTitle(input) {
  let t = String(input || '');
  // emoji 与符号
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
  // 榜单常见前后缀标记
  t = t.replace(/(^|\s)(热|沸|新|爆|荐|置顶)(\s|$)/g, ' ');
  // 各类括号与引号
  t = t.replace(/[「」『』【】\[\]（）()《》〈〉<>""''‘’“”]/g, '');
  t = t.replace(/[#＃*]/g, ' ');
  // 标点与空白
  t = t.replace(/[！!？?。，,、：:；;·…—－\-_~|/\\+=]/g, ' ');
  t = t.replace(/\s+/g, '');
  return t.toLowerCase();
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 抽取引号内的实体，用于「同一实体的不同说法」合并 */
function extractQuoted(rawTitle) {
  const out = [];
  const re = /[「『【“"']([^」』】”"']{2,20})[」』】”"']/g;
  let m = re.exec(String(rawTitle || ''));
  while (m) {
    out.push(m[1].trim());
    m = re.exec(String(rawTitle || ''));
  }
  return out;
}

/* ---------------- 聚类 ---------------- */

function makeUnionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  return { find, union };
}

/**
 * @param {Array} items 来自各源的归一化条目（含 platform / platformName / rank / hot）
 * @param {Object} counts 各源条数，用于计算排名分
 */
function clusterItems(items, counts) {
  const prepared = items.map((it) => {
    const norm = normalizeTitle(it.title);
    return {
      ...it,
      norm,
      grams: bigrams(norm),
      quoted: extractQuoted(it.title),
      rankScore: counts[it.platform] ? (counts[it.platform] - it.rank + 1) / counts[it.platform] : 0,
    };
  });

  const uf = makeUnionFind(prepared.length);

  const shouldMerge = (a, b) => {
    if (!a.norm || !b.norm) return false;
    if (a.norm.length >= CONTAINMENT_MIN_LEN && b.norm.length >= CONTAINMENT_MIN_LEN) {
      if (a.norm.includes(b.norm) || b.norm.includes(a.norm)) return true;
    }
    if (a.quoted.length && b.quoted.length) {
      for (const q of a.quoted) if (q.length >= 3 && b.quoted.includes(q)) return true;
    }
    return jaccard(a.grams, b.grams) >= JACCARD_THRESHOLD;
  };

  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      if (shouldMerge(prepared[i], prepared[j])) uf.union(i, j);
    }
  }

  const groups = new Map();
  prepared.forEach((it, i) => {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it);
  });

  return [...groups.values()];
}

/* ---------------- 打分 ---------------- */

function tagBonus(tag) {
  if (!tag) return 1;
  return /[热沸新爆]/.test(String(tag)) ? 1.08 : 1;
}

function scoreCluster(group, weightOf) {
  let sum = 0;
  let hotSum = 0;
  const platforms = new Set();

  // 同一平台在簇内只取排名最好的一条计入分数，避免单平台刷分
  const bestPerPlatform = new Map();
  for (const it of group) {
    const prev = bestPerPlatform.get(it.platform);
    if (!prev || it.rankScore > prev.rankScore) bestPerPlatform.set(it.platform, it);
  }

  for (const it of bestPerPlatform.values()) {
    const w = weightOf[it.platform] || 0.5;
    sum += w * it.rankScore * tagBonus(it.tag);
    platforms.add(it.platform);
  }
  for (const it of group) if (Number.isFinite(it.hot)) hotSum += it.hot;

  const crossBoost = Math.min(1.75, 1 + 0.25 * Math.max(0, platforms.size - 1));
  return { score: sum * crossBoost, hotSum, platformCount: platforms.size, bestPerPlatform };
}

/** 选代表条目：取权重最高平台中最靠前的那条 */
function pickItem(bestPerPlatform, weightOf) {
  let best = null;
  for (const it of bestPerPlatform.values()) {
    const w = weightOf[it.platform] || 0.5;
    const key = w * 1000 + it.rankScore;
    if (!best || key > best.key) best = { key, item: it };
  }
  return best ? best.item : null;
}

function pickTitle(bestPerPlatform, weightOf) {
  const it = pickItem(bestPerPlatform, weightOf);
  return it ? it.title : '';
}

/* ---------------- 板块分类 ---------------- */

/** 辅助文本截断长度：知乎 detail 可到 2000+ 字，不截断会因长文里偶然命中一个词而乱定板 */
const AUX_MAX_CHARS = 120;
/** 辅助字段命中权重：desc 是编辑过的摘要，比正文 content 可信 */
const AUX_DESC_WEIGHT = 0.5;
const AUX_CONTENT_WEIGHT = 0.3;
/** 辅助轮的最低加权得分（一个 desc 命中恰好 0.5×2=1.0；单独一个 content 命中 0.3 不够） */
const AUX_MIN_SCORE = 0.5;

/**
 * 辅助轮里忽略的「形式词」。
 * 这类词描述的是内容的**体裁**（这是一条八卦 / 一条回应 / 一条爆料），而不是**主题**。
 * 放在标题里有用（"某演员回应恋情传闻"确实偏娱乐），但一旦进了长摘要几乎必然出现，
 * 只会把无关内容拽进某个板块。所以标题轮照常用，辅助轮一律不算。
 */
const AUX_IGNORE = new Set([
  '热搜',
  '爆料',
  '官宣',
  '疑似',
  '现身',
  '发文',
  '近照',
  '走红',
  '摆拍',
  '偶遇',
  '回应',
  '曝光',
  '奥运',
]);

/**
 * 分类结果四档来源 + 置信度：
 *   keyword  —— 标题命中关键词，取命中数最多者（多命中时用平台先验加权打平局）。confidence=high
 *   aux      —— 标题零命中，靠 desc/content 辅助文本推断。confidence=low
 *   prior    —— 平台特征兜底（默认已清空 fallbackPriors，需要时可在 config 里开回）。confidence=low
 *   fallback —— 判不出来，落「其他」。confidence=low
 *   模型终审后来源会被改写成 'ai'，置信度 high。
 *
 * 为什么分两轮：标题是编辑过的高度浓缩信息，辅助文本是长文、噪声大得多。
 * 所以标题命中即定板、不再看辅助文本；只有标题一个词都没命中时，才让辅助文本补漏，且要够到门槛。
 */
function classifyBoardEx({ title, platform, desc, content } = {}) {
  const t = String(title || '');
  const priors = (CONFIG.priors && CONFIG.priors[platform]) || [];

  // ---- 第一轮：只看标题 ----
  let winner = null;
  for (const board of CONFIG.boards) {
    let hits = 0;
    for (const kw of board.keywords) {
      if (t.includes(kw)) hits += 1;
    }
    if (hits === 0) continue;
    const total = hits + (priors.includes(board.id) ? 0.5 : 0);
    if (!winner || total > winner.total) {
      winner = { id: board.id, total, source: 'keyword', confidence: 'high' };
    }
  }
  if (winner) return winner;

  // ---- 第二轮：标题零命中，才看辅助文本 ----
  const d = String(desc || '').slice(0, AUX_MAX_CHARS);
  const c = String(content || '').slice(0, AUX_MAX_CHARS);
  if (d || c) {
    let auxBest = null;
    for (const board of CONFIG.boards) {
      let score = 0;
      for (const kw of board.keywords) {
        if (AUX_IGNORE.has(kw)) continue;
        if (d && d.includes(kw)) score += AUX_DESC_WEIGHT;
        else if (c && c.includes(kw)) score += AUX_CONTENT_WEIGHT;
      }
      if (score <= 0) continue;
      const total = score + (priors.includes(board.id) ? 0.5 : 0);
      if (!auxBest || total > auxBest.total) {
        auxBest = { id: board.id, total, source: 'aux', confidence: 'low' };
      }
    }
    if (auxBest && auxBest.total >= AUX_MIN_SCORE) return auxBest;
  }

  // ---- 兜底 ----
  const fb = CONFIG.fallbackPriors && CONFIG.fallbackPriors[platform];
  if (typeof fb === 'string' && CONFIG.boards.some((b) => b.id === fb)) {
    return { id: fb, total: 0, source: 'prior', confidence: 'low' };
  }
  return { id: CONFIG.fallbackBoard || 'other', total: 0, source: 'fallback', confidence: 'low' };
}

/* ---------------- 组装成稿 ---------------- */

/**
 * 日期键加减天数（GMT+8 日历日）。
 *
 * ⚠️ 这里曾经差一天：先用 `T00:00:00+08:00` 把零点转成 UTC（= 前一天 16:00），
 * 再用 `toISOString()` 按 **UTC** 取日期，等于白退一天 —— `shiftDateKey('2026-10-10', 0)`
 * 返回 `2026-10-09`，`-1` 返回 `2026-10-08`。后果是涨跌对比的「昨日」实际是**前天**。
 * 现在统一走 time.js 的 GMT+8 口径（加 8 小时再取 UTC 日期），与 dateKey() 同源。
 */
function shiftDateKey(dateKeyStr, days) {
  const base = Date.parse(`${dateKeyStr}T00:00:00+08:00`);
  return dateKey(base + days * 86400000);
}

/**
 * @param {Object} opts
 * @param {string} opts.date
 * @param {Array} opts.sourceResults fetch 层返回的各源结果
 * @param {Object|null} opts.prevDigest 昨日的成稿（用于涨跌）
 */
function buildDigest({ date, sourceResults, prevDigest, fetchedAt }) {
  const weightOf = {};
  const counts = {};
  const all = [];

  for (const src of sourceResults) {
    counts[src.id] = src.count || (src.items || []).length || 0;
  }
  // 权重来自 sources 定义，避免这里再维护一份
  const { SOURCES } = require('./fetch/sources');
  for (const s of SOURCES) weightOf[s.id] = s.weight;

  for (const src of sourceResults) {
    for (const it of src.items || []) all.push(it);
  }

  const groups = clusterItems(all, counts);

  /**
   * 平台原始条目 → 所属簇的 key。
   * 平台榜里的每条也要能对应到聚类结果，否则模型终审改过的板块没法回写到平台视图。
   * 用 platform#rank 做键：同一平台上排名唯一。
   */
  const keyOfPlatformRank = new Map();

  const clusters = groups
    .map((group) => {
      const scored = scoreCluster(group, weightOf);
      const rep = pickItem(scored.bestPerPlatform, weightOf);
      const title = rep ? rep.title : '';
      const key = normalizeTitle(title);
      // 先验用代表条目所在平台；辅助轮拿到它自己的 desc/content
      const boardInfo = classifyBoardEx({
        title,
        platform: rep ? rep.platform : group[0].platform,
        desc: rep ? rep.desc : '',
        content: rep ? rep.content : '',
      });
      const board = boardInfo.id;
      if (title) for (const it of group) keyOfPlatformRank.set(`${it.platform}#${it.rank}`, key);

      const sources = [...scored.bestPerPlatform.values()]
        .map((it) => ({
          platform: it.platform,
          name: it.platformName,
          title: it.title,
          url: it.url,
          hot: it.hot,
          hotText: it.hotText,
          desc: it.desc || null,
          content: it.content || null,
        }))
        .sort((a, b) => (b.hot || 0) - (a.hot || 0));

      return {
        key,
        title,
        board,
        boardName: BOARD_NAME[board] || '其他',
        boardSource: boardInfo.source,
        confidence: boardInfo.confidence,
        score: Number(scored.score.toFixed(4)),
        hotSum: scored.hotSum,
        platformCount: scored.platformCount,
        sources,
      };
    })
    .filter((c) => c.title);

  // 全局排名（用于涨跌对比与 Top10 选取）
  clusters.sort((a, b) => b.score - a.score || b.hotSum - a.hotSum);
  clusters.forEach((c, i) => {
    c.globalRank = i + 1;
  });

  // ---- 涨跌标记 ----
  const prevRank = new Map();
  if (prevDigest && Array.isArray(prevDigest.allItems)) {
    for (const it of prevDigest.allItems) prevRank.set(it.key, it.globalRank);
  }
  for (const c of clusters) {
    if (!prevRank.has(c.key)) c.badge = 'new';
    else {
      const delta = prevRank.get(c.key) - c.globalRank;
      c.badge = delta >= 5 ? 'surge' : 'steady';
    }
  }

  // ---- 去同质化选 Top10：按板块轮转，单板块上限 3 席 ----
  const top10 = [];
  const perBoard = new Map();
  const pool = [...clusters];
  let guard = 0;
  while (top10.length < TOP_N && guard < pool.length * 3) {
    guard += 1;
    let advanced = false;
    const boardsInOrder = [...new Set(pool.map((c) => c.board))];
    for (const b of boardsInOrder) {
      if (top10.length >= TOP_N) break;
      if ((perBoard.get(b) || 0) >= BOARD_CAP) continue;
      const idx = pool.findIndex((c) => c.board === b && !c.picked);
      if (idx === -1) continue;
      const c = pool[idx];
      c.picked = true;
      top10.push(c);
      perBoard.set(b, (perBoard.get(b) || 0) + 1);
      advanced = true;
    }
    if (!advanced) break;
  }

  // 榜单条目统一结构
  const serialize = (c, isTop, rank) => ({
    key: c.key,
    title: c.title,
    board: c.board,
    boardName: c.boardName,
    boardSource: c.boardSource,
    confidence: c.confidence,
    score: c.score,
    globalRank: c.globalRank,
    badge: c.badge,
    rank: rank == null ? null : rank,
    sources: c.sources.map((s) => ({
      platform: s.platform,
      name: s.name,
      url: s.url,
      hot: s.hot,
      hotText: s.hotText,
      title: s.title,
      desc: s.desc || null,
      content: s.content || null,
    })),
    deepRead: null,
    top: !!isTop,
  });

  const topItems = top10.map((c, i) => serialize(c, true, i + 1));
  const topKeys = new Set(topItems.map((i) => i.key));

  const boardMap = new Map();
  for (const c of clusters) {
    if (topKeys.has(c.key)) continue;
    if (!boardMap.has(c.board)) boardMap.set(c.board, []);
    boardMap.get(c.board).push(serialize(c, false, boardMap.get(c.board).length + 1));
  }

  const boards = [...boardMap.entries()]
    .map(([id, items]) => ({ id, name: BOARD_NAME[id] || '其他', items }))
    .sort((a, b) => b.items.length - a.items.length);

  const allItems = clusters.map((c) => ({
    key: c.key,
    title: c.title,
    globalRank: c.globalRank,
    board: c.board,
  }));

  /**
   * 各平台的原始榜单（不合并不去重，保留该平台自己的排名与热度）。
   * 用途：界面上的「平台」视图——用户点「微博」就是要看微博今天的榜，而不是合并后的结果。
   * 每条也带一遍板块归类，这样平台视图里能继续按类目二次筛选。
   */
  const platforms = sourceResults.map((src) => {
    const items = (src.items || []).map((it) => {
      const info = classifyBoardEx({
        title: it.title,
        platform: src.id,
        desc: it.desc,
        content: it.content,
      });
      return {
        rank: it.rank,
        key: keyOfPlatformRank.get(`${src.id}#${it.rank}`) || normalizeTitle(it.title),
        title: it.title,
        url: it.url || '',
        hot: Number.isFinite(it.hot) ? it.hot : null,
        hotText: it.hotText || '',
        desc: it.desc || null,
        content: it.content || null,
        platform: src.id,
        platformName: src.name,
        board: info.id,
        boardName: BOARD_NAME[info.id] || '其他',
        boardSource: info.source,
        confidence: info.confidence,
      };
    });
    return {
      id: src.id,
      name: src.name,
      status: src.status,
      error: src.error || null,
      count: items.length,
      items,
    };
  });

  return {
    date,
    fetchedAt,
    generatedAt: isoCst(),
    generatedBy: 'auto',
    sourceStatus: sourceResults.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      count: s.count,
      error: s.error,
      usedBackup: !!s.usedBackup,
    })),
    stats: {
      totalItems: all.length,
      clusters: clusters.length,
      boards: boards.length,
    },
    top10: topItems,
    boards,
    platforms,
    allItems,
    prevDate: prevDigest ? prevDigest.date : null,
  };
}

module.exports = {
  normalizeTitle,
  bigrams,
  jaccard,
  clusterItems,
  classifyBoardEx,
  buildDigest,
  shiftDateKey,
  JACCARD_THRESHOLD,
  TOP_N,
};
