'use strict';

const { dateKey, isoCst } = require('../time');

/**
 * 开发期样例数据（P1 用于验证界面）。
 * 真实数据接入后，仅在「当天无数据」时作为占位，便于确认识别界面结构。
 */
function sampleDigest() {
  const now = Date.now();
  const mk = (board, boardName, title, platforms, score, badge, deepRead) => ({
    key: `sample-${title}`,
    title,
    board,
    boardName,
    score,
    badge,
    deepRead: deepRead || null,
    sources: platforms.map((p, i) => ({
      platform: p.id,
      name: p.name,
      url: p.url,
      hot: 3000000 - i * 400000,
      hotText: `${((3000000 - i * 400000) / 10000).toFixed(1)}万`,
    })),
  });

  const w = (u) => ({ id: 'weibo', name: '微博', url: u });
  const r = (u) => ({ id: 'rednote', name: '小红书', url: u });
  const z = (u) => ({ id: 'zhihu', name: '知乎', url: u });
  const d = (u) => ({ id: 'douyin', name: '抖音', url: u });
  const b = (u) => ({ id: 'baidu', name: '百度', url: u });
  const q = (u) => ({ id: 'quark', name: '夸克', url: u });

  const top10 = [
    mk('society', '社会民生', '男子河里捞出春秋编钟卖30万获刑5年', [w('https://s.weibo.com/'), b('https://m.baidu.com/')], 1.72, 'new',
      '2011 年唐某在广西柳城县河道捞沙时拾得春秋编钟，2013 年以 30 万元出售。\n最高法与国家文物局联合发布文物犯罪典型案例，该案在列。\n争议点在"拣拾"与"盗掘"的界限，以及 30 万元是否属明显低价。'),
    mk('ent', '娱乐', '某演员工作室否认恋情传闻', [w('https://s.weibo.com/'), d('https://www.douyin.com/')], 1.55, 'surge', null),
    mk('ent', '娱乐', '国庆档票房最终数据出炉', [w('https://s.weibo.com/'), d('https://www.douyin.com/')], 1.41, 'steady', null),
    mk('tech', '科技数码', '卫星互联网低轨27组卫星成功发射', [w('https://s.weibo.com/'), z('https://www.zhihu.com/')], 1.38, 'new', null),
    mk('finance', '财经商业', 'A股三大指数集体收涨', [b('https://m.baidu.com/'), q('https://quark.sm.cn/')], 1.30, null, null),
    mk('sports', '体育竞技', '国乒教练王皓被围堵辱骂 3人被行政拘留', [w('https://s.weibo.com/'), z('https://www.zhihu.com/')], 1.28, 'surge', null),
    mk('world', '国际时政', '某地区局势出现新进展', [b('https://m.baidu.com/'), q('https://quark.sm.cn/')], 1.22, null, null),
    mk('life', '生活种草', '用万能旅行拍照姿势美美出片', [r('https://www.xiaohongshu.com/')], 1.18, 'steady', null),
    mk('health', '健康养生', '秋冬换季呼吸道疾病防护要点', [b('https://m.baidu.com/'), r('https://www.xiaohongshu.com/')], 1.05, null, null),
    mk('other', '其他', '距今最近的日环食观测时间公布', [z('https://www.zhihu.com/'), d('https://www.douyin.com/')], 0.98, 'new', null),
  ];

  const rest = [
    mk('society', '社会民生', '单亲妈妈仅退款童装勒索3千被刑拘', [w('https://s.weibo.com/')], 0.9, null, null),
    mk('society', '社会民生', '多地出台住房公积金新政', [b('https://m.baidu.com/')], 0.8, null, null),
    mk('ent', '娱乐', '某综艺片段引发现场争议', [d('https://www.douyin.com/')], 0.78, null, null),
    mk('life', '生活种草', '耗时三年拍下古诗词里的中国', [r('https://www.xiaohongshu.com/')], 0.75, null, null),
    mk('life', '生活种草', '我拍到了海鸥雨', [r('https://www.xiaohongshu.com/')], 0.7, null, null),
    mk('tech', '科技数码', '国产大模型推理成本再降', [z('https://www.zhihu.com/')], 0.68, null, null),
  ];

  const all = [...top10, ...rest];

  // 与真实成稿同构：boards 里不含已进 Top10 的条目
  const topKeys = new Set(top10.map((t) => t.key));
  const boards = {};
  for (const item of rest) {
    if (topKeys.has(item.key)) continue;
    if (!boards[item.board]) boards[item.board] = [];
    boards[item.board].push(item);
  }

  // 各平台原始榜（样例）：按条目里出现的来源归集，保证平台视图有内容
  const PLATFORM_LIST = [
    { id: 'weibo', name: '微博' },
    { id: 'rednote', name: '小红书' },
    { id: 'zhihu', name: '知乎' },
    { id: 'douyin', name: '抖音' },
    { id: 'toutiao', name: '今日头条' },
    { id: 'baidu', name: '百度' },
    { id: 'quark', name: '夸克' },
  ];
  const platforms = PLATFORM_LIST.map((p) => {
    const items = all
      .filter((it) => (it.sources || []).some((s) => s.platform === p.id))
      .map((it, i) => {
        const src = (it.sources || []).find((s) => s.platform === p.id) || {};
        return {
          rank: i + 1,
          title: it.title,
          url: src.url || '',
          hot: src.hot || null,
          hotText: src.hotText || '',
          board: it.board,
          boardName: it.boardName,
          boardSource: 'keyword',
        };
      });
    return { id: p.id, name: p.name, status: 'ok', error: null, count: items.length, items };
  });

  return {
    date: dateKey(now),
    generatedAt: isoCst(now),
    generatedBy: 'sample',
    sourceStatus: [
      { id: 'weibo', name: '微博', status: 'ok', count: 20 },
      { id: 'rednote', name: '小红书', status: 'ok', count: 20 },
      { id: 'zhihu', name: '知乎', status: 'ok', count: 20 },
      { id: 'douyin', name: '抖音', status: 'ok', count: 20 },
      { id: 'toutiao', name: '今日头条', status: 'ok', count: 20 },
      { id: 'baidu', name: '百度', status: 'ok', count: 20 },
      { id: 'quark', name: '夸克', status: 'ok', count: 20 },
    ],
    stats: { totalItems: all.length, clusters: all.length, boards: Object.keys(boards).length },
    top10,
    boards: Object.entries(boards).map(([id, items]) => ({ id, name: items[0].boardName, items })),
    platforms,
    isSample: true,
  };
}

module.exports = { sampleDigest };
