'use strict';

const { getJson, sleep } = require('./httpClient');
const { SOURCES, loadSource } = require('./sources');

/**
 * 抓取编排。
 *
 * 两个关键点：
 * 1. **串行 + 源间隔**：公共实例连发会触发 Cloudflare 1015 频控，实测间隔 ~3s 即稳定。
 * 2. **单飞锁**：启动补抓、定时抓取、手动抓取可能同时触发，必须复用同一个 Promise，
 *    否则既浪费额度又会让频控命中。
 */

const SPACING_MS = 3200;

let inFlight = null;

async function fetchAllSources({ onProgress } = {}) {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const startedAt = Date.now();
    const results = [];
    const total = SOURCES.length;

    for (let i = 0; i < total; i += 1) {
      const source = SOURCES[i];
      if (onProgress) {
        onProgress({ stage: 'source:start', index: i + 1, total, source: source.id, name: source.name });
      }

      let entry;
      try {
        const loaded = await loadSource(source, {
          getJson,
          onAttempt: (info) => onProgress && onProgress({ stage: 'attempt', ...info }),
        });
        entry = {
          id: loaded.id,
          name: loaded.name,
          status: 'ok',
          count: loaded.count,
          error: null,
          usedBackup: loaded.usedBackup,
          items: loaded.items,
        };
      } catch (err) {
        entry = {
          id: source.id,
          name: source.name,
          status: 'fail',
          count: 0,
          error: String((err && err.message) || err),
          items: [],
        };
      }

      results.push(entry);
      if (onProgress) {
        onProgress({
          stage: 'source:done',
          index: i + 1,
          total,
          source: entry.id,
          name: entry.name,
          status: entry.status,
          count: entry.count,
          error: entry.error,
        });
      }

      // 源之间错峰，最后一个不必再等
      if (i < total - 1) await sleep(SPACING_MS);
    }

    return { results, startedAt, finishedAt: Date.now() };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

module.exports = { fetchAllSources, SPACING_MS };
