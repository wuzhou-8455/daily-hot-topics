'use strict';

/** GMT+8（中国标准时间）时间工具。日期一律按固定 +8 偏移计算，不依赖系统时区。 */

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** YYYY-MM-DD（GMT+8） */
function dateKey(ts) {
  const t = ts == null ? Date.now() : ts;
  return new Date(t + CST_OFFSET_MS).toISOString().slice(0, 10);
}

/** HH:MM（GMT+8） */
function hhmm(ts) {
  const t = ts == null ? Date.now() : ts;
  return new Date(t + CST_OFFSET_MS).toISOString().slice(11, 16);
}

/** ISO 字符串（带 +08:00 偏移） */
function isoCst(ts) {
  const t = ts == null ? Date.now() : ts;
  return new Date(t + CST_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+08:00');
}

/**
 * 下一个「GMT+8 的 hour:minute」时间戳。
 * @param {number} hour 小时（CST）
 * @param {number} minute 分钟（CST）
 * @param {number} from 基准时间戳，默认现在
 */
function nextDailyRun(hour = 8, minute = 30, from = Date.now()) {
  const cst = new Date(from + CST_OFFSET_MS);
  const y = cst.getUTCFullYear();
  const mo = cst.getUTCMonth();
  const d = cst.getUTCDate();
  let target = Date.UTC(y, mo, d, hour, minute, 0, 0) - CST_OFFSET_MS;
  if (target <= from) target += 24 * 60 * 60 * 1000;
  return target;
}

module.exports = { CST_OFFSET_MS, dateKey, hhmm, isoCst, nextDailyRun };
