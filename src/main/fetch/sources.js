'use strict';

/**
 * 数据源定义与字段归一化。
 *
 * 字段结构为 2026-10-10 实测确认，任何一处对不上都会导致该源静默变空，
 * 所以每个 normalizer 都只做「取值 + 兜底」，不做业务判断。
 */

const BASE_URL = 'https://60s.viki.moe';

/** 每个源最多取多少条，控制体积 */
const PER_SOURCE_LIMIT = 30;

function sourceDescription(item) {
  return [item.desc, item.description, item.summary, item.detail]
    .find(value => typeof value === 'string' && value.trim()) || null;
}

/** 把 "947.5w" / "2265 万热度" / 7808110 统一成数字 */
function parseHot(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'string') return null;
  const m = input.trim().toLowerCase().match(/([\d.]+)\s*(亿|万|w|k)?/);
  if (!m) return null;
  let n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '亿') n *= 1e8;
  else if (unit === '万' || unit === 'w') n *= 1e4;
  else if (unit === 'k') n *= 1e3;
  return Math.round(n);
}

/** 热度展示文本：大数折成「万」 */
function formatHot(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(Math.round(n));
}

const SOURCES = [
  {
    id: 'weibo',
    name: '微博',
    url: `${BASE_URL}/v2/weibo`,
    weight: 1.0,
    normalize(list) {
      return (list || []).map((it, i) => ({
        rank: i + 1,
        title: it.title,
        url: it.link || '',
        hot: parseHot(it.hot_value),
        hotText: formatHot(parseHot(it.hot_value)),
        desc: sourceDescription(it),
        content: typeof it.content === 'string' ? it.content : null,
      }));
    },
  },
  {
    id: 'rednote',
    name: '小红书',
    url: `${BASE_URL}/v2/rednote`,
    weight: 0.95,
    normalize(list) {
      return (list || []).map((it, i) => {
        const hot = parseHot(it.score);
        return {
          rank: Number(it.rank) || i + 1,
          title: it.title,
          url: it.link || '',
          hot,
          hotText: it.score || formatHot(hot),
          desc: sourceDescription(it),
          content: typeof it.content === 'string' ? it.content : null,
          tag: it.word_type && it.word_type !== '无' ? it.word_type : null,
        };
      });
    },
  },
  {
    id: 'zhihu',
    name: '知乎',
    url: `${BASE_URL}/v2/zhihu`,
    weight: 0.7,
    normalize(list) {
      return (list || []).map((it, i) => {
        const hot = parseHot(it.hot_value_desc);
        return {
          rank: i + 1,
          title: it.title,
          url: it.link || '',
          hot,
          hotText: it.hot_value_desc || formatHot(hot),
          desc: it.detail || sourceDescription(it),
          content: null,
        };
      });
    },
  },
  {
    id: 'douyin',
    name: '抖音',
    url: `${BASE_URL}/v2/douyin`,
    weight: 0.9,
    normalize(list) {
      return (list || []).map((it, i) => {
        const hot = parseHot(it.hot_value);
        return {
          rank: i + 1,
          title: it.title,
          url: it.link || '',
          hot,
          hotText: formatHot(hot),
          desc: sourceDescription(it),
          content: typeof it.content === 'string' ? it.content : null,
        };
      });
    },
  },
  {
    id: 'toutiao',
    name: '今日头条',
    url: `${BASE_URL}/v2/toutiao`,
    weight: 0.65,
    normalize(list) {
      return (list || []).map((it, i) => {
        const hot = parseHot(it.hot_value);
        return {
          rank: i + 1,
          title: it.title,
          url: it.link || '',
          hot,
          hotText: formatHot(hot),
          desc: sourceDescription(it),
          content: typeof it.content === 'string' ? it.content : null,
        };
      });
    },
  },
  {
    id: 'baidu',
    name: '百度',
    url: `${BASE_URL}/v2/baidu/hot`,
    weight: 0.85,
    backup: { type: 'baiduOfficial', url: 'https://top.baidu.com/api/board?platform=wise&tab=realtime' },
    normalize(list) {
      return (list || []).map((it, i) => {
        const hot = parseHot(it.score);
        return {
          rank: Number(it.rank) || i + 1,
          title: it.title,
          url: it.url || '',
          hot,
          hotText: it.score_desc || formatHot(hot),
          desc: sourceDescription(it),
          content: null,
        };
      });
    },
    /** 官方接口的返回结构与 60s 不同，单独拆一层 */
    normalizeBackup(raw) {
      const cards = (raw && raw.data && raw.data.cards) || [];
      const flat = [];
      for (const card of cards) {
        for (const block of card.content || []) {
          for (const it of block.content || []) {
            if (it && it.word) {
              flat.push({
                rank: flat.length + 1,
                title: it.word,
                url: it.url || `https://m.baidu.com/s?word=${encodeURIComponent(it.word)}`,
                hot: parseHot(it.hotScore),
                hotText: it.hotScore || '',
                desc: (it.desc || '').trim() || null,
                content: null,
              });
            }
          }
        }
      }
      return flat;
    },
  },
  {
    id: 'quark',
    name: '夸克',
    url: `${BASE_URL}/v2/quark`,
    weight: 0.6,
    normalize(list) {
      return (list || []).map((it, i) => {
        const engage =
          (Number(it.like_count) || 0) + (Number(it.share_count) || 0) + (Number(it.comment_count) || 0);
        return {
          rank: i + 1,
          title: (it.title || '').trim(),
          url: it.link || '',
          hot: engage || null,
          hotText: engage ? formatHot(engage) : '',
          desc: sourceDescription(it),
          content: it.content || null,
          source: it.source || null,
        };
      });
    },
  },
];

/**
 * 取某个源的数据（含备份源）。
 * 返回 { id, name, status, count, error, items }
 */
async function loadSource(source, { getJson, onAttempt }) {
  const attemptOnce = async (url, normalize) => {
    const raw = await getJson(url, {
      retries: 2,
      timeoutMs: 20000,
      onAttempt: (n) => onAttempt && onAttempt({ source: source.id, attempt: n }),
    });
    const list = Array.isArray(raw && raw.data) ? raw.data : null;
    if (!list) throw new Error('返回结构异常：缺少 data 数组');
    const items = normalize(list).filter((it) => it.title);
    return { raw, items };
  };

  try {
    const primary = await attemptOnce(source.url, source.normalize);
    return { ...toResult(source, primary.items), raw: primary.raw, usedBackup: false };
  } catch (primaryErr) {
    if (!source.backup) throw primaryErr;

    // 主源失败 → 尝试官方备份源
    const raw = await getJson(source.backup.url, {
      retries: 1,
      timeoutMs: 20000,
      onAttempt: (n) => onAttempt && onAttempt({ source: source.id, attempt: n, backup: true }),
    });
    const items = source.normalizeBackup(raw).filter((it) => it.title);
    if (!items.length) throw new Error(`主源与备份源都无数据（主源错误：${primaryErr.message}）`);
    return { ...toResult(source, items), raw, usedBackup: true };
  }
}

function toResult(source, items) {
  const trimmed = items.slice(0, PER_SOURCE_LIMIT).map((it) => ({
    ...it,
    platform: source.id,
    platformName: source.name,
  }));
  return {
    id: source.id,
    name: source.name,
    status: 'ok',
    count: trimmed.length,
    error: null,
    items: trimmed,
  };
}

module.exports = { SOURCES, BASE_URL, PER_SOURCE_LIMIT, parseHot, formatHot, loadSource };
