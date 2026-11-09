'use strict';

const { fetchAllSources } = require('../fetch');
const classifier = require('../classifier');
const daily = require('../store/daily');
const readings = require('../store/readings');

/**
 * 一次完整的抓取流水线：抓取 → 落盘原始 → 聚类分类打分 → 落盘成稿。
 * 解读（deepRead）不在这里生成，由 AI 层按需补写，避免每次抓取都消耗模型额度。
 */
async function runOnce({ date, onProgress }) {
  if (!date) throw new Error('缺少 date');
  const previousToday = daily.loadDigest(date);

  if (onProgress) onProgress({ stage: 'fetch:start', date });
  const { results, finishedAt } = await fetchAllSources({ onProgress });

  // 原始快照落盘（取证 + 涨跌对比的依据）
  daily.saveRaw(date, {
    date,
    fetchedAt: finishedAt,
    sources: results.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      count: r.count,
      error: r.error,
      usedBackup: !!r.usedBackup,
      items: r.items,
    })),
  });

  const prevDate = classifier.shiftDateKey(date, -1);
  const prevDigest = daily.loadDigest(prevDate);

  if (onProgress) onProgress({ stage: 'classify:start' });
  const digest = classifier.buildDigest({
    date,
    sourceResults: results,
    prevDigest,
    fetchedAt: finishedAt,
  });
  readings.preserve(digest, previousToday);
  daily.saveDigest(date, digest);

  const okCount = digest.sourceStatus.filter((s) => s.status === 'ok').length;
  if (onProgress) {
    onProgress({ stage: 'done', date, okCount, total: digest.sourceStatus.length });
  }

  return {
    date,
    itemCount: digest.stats.totalItems,
    clusterCount: digest.stats.clusters,
    okSources: okCount,
    failedSources: digest.sourceStatus.filter((s) => s.status !== 'ok').map((s) => s.name),
    top10: digest.top10.map((t) => ({
      rank: t.rank,
      title: t.title,
      board: t.boardName,
      badge: t.badge,
      sources: t.sources.map((s) => s.name).join('+'),
    })),
  };
}

module.exports = { runOnce };
