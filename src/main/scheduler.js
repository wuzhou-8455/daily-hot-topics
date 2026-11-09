'use strict';

const { app, powerMonitor } = require('electron');
const { dateKey, nextDailyRun, hhmm } = require('./time');
const daily = require('./store/daily');
const configStore = require('./store/config');
const { state } = require('./ipc');

/**
 * 定时抓取（GMT+8 每天 08:30）+ 启动补抓 + 5 分钟心跳兜底。
 * 心跳用于覆盖「休眠 / 时钟漂移 / 定时器被打断」导致错过时间点的情况。
 */

const HEARTBEAT_MS = 5 * 60 * 1000;

let timer = null;
let heartbeat = null;
let isRunning = false;
let getWin = null;
let scheduledAt = 0;

function notify(channel, payload) {
  try {
    const win = getWin && getWin();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  } catch {
    /* 窗口可能已关闭，忽略 */
  }
}

/**
 * 跑一次抓取。所有触发口（定时 / 启动补抓 / 心跳 / 手动）都走这里，保证单飞与状态一致。
 * @param {string} reason schedule | startup | heartbeat | resume | unlock | manual
 * @param {Object} [opts]
 * @param {string} [opts.date] 指定落盘日期，默认今天（GMT+8）
 */
async function runDaily(reason, opts = {}) {
  if (isRunning) return { ok: false, error: '已有抓取在进行中' };
  if (require('./ai/reading-flow').isBusy()) return { ok: false, error: '正在生成解读，请完成后再更新榜单。' };
  isRunning = true;
  const today = opts.date || dateKey();
  state.fetching = true;
  notify('ev:fetchProgress', { stage: 'start', reason, date: today });

  try {
    const pipeline = require('./pipeline/run');
    const result = await pipeline.runOnce({
      date: today,
      onProgress: (p) => {
        state.lastProgress = p;
        notify('ev:fetchProgress', p);
      },
    });

    state.lastRunAt = Date.now();
    state.lastRunOk = true;
    state.lastRunNote = `成功：${(result && result.itemCount) || 0} 条 / ${(result && result.clusterCount) || 0} 合并`;
    notify('ev:dataUpdated', { date: today });
    state.fetching = false;
    try {
      const ai = await require('./ai/reading-flow').runAuto(today, (p) => notify('ev:aiProgress', p));
      if (!ai.skipped) notify('ev:dataUpdated', { date: today });
    } catch (error) {
      notify('ev:error', { message: '榜单已更新，自动解读失败：' + error.message });
    }
    try {
      require('./tray').refreshTooltip();
    } catch {
      /* 托盘可能没启用 */
    }
    return { ok: true, date: today, ...(result || {}) };
  } catch (err) {
    const msg = String((err && err.message) || err);
    state.lastRunAt = Date.now();
    state.lastRunOk = false;
    state.lastRunNote = msg;
    notify('ev:error', { message: msg });
    return { ok: false, error: msg };
  } finally {
    isRunning = false;
    state.fetching = false;
  }
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  const cfg = configStore.load();
  const hour = Number.isFinite(cfg.autoFetchHour) ? cfg.autoFetchHour : 8;
  const minute = Number.isFinite(cfg.autoFetchMinute) ? cfg.autoFetchMinute : 30;
  scheduledAt = nextDailyRun(hour, minute);
  const delay = Math.max(1000, scheduledAt - Date.now());
  console.log(`[scheduler] 下次抓取 ${dateKey(scheduledAt)} ${hhmm(scheduledAt)}（${Math.round(delay / 60000)} 分钟后）`);
  timer = setTimeout(async () => {
    await runDaily('schedule');
    scheduleNext();
  }, delay);
}

/** 启动补抓 + 心跳：只要今天还没有成稿，就补一次 */
async function catchUp(reason) {
  const today = dateKey();
  if (daily.hasDigest(today)) return { skipped: true };
  return runDaily(reason);
}

function start(getWinFn) {
  getWin = getWinFn;

  app.whenReady().then(async () => {
    // 启动补抓：不阻塞界面
    setTimeout(() => {
      catchUp('startup').catch(() => {});
    }, 2500);

    scheduleNext();

    heartbeat = setInterval(() => {
      catchUp('heartbeat').catch(() => {});
    }, HEARTBEAT_MS);

    // 休眠唤醒后重新判断（setTimeout 在休眠期间不准）
    try {
      powerMonitor.on('resume', () => {
        catchUp('resume').catch(() => {});
        scheduleNext();
      });
      powerMonitor.on('unlock-screen', () => {
        catchUp('unlock').catch(() => {});
      });
    } catch {
      /* 某些平台不支持，忽略 */
    }
  });
}

function stop() {
  if (timer) clearTimeout(timer);
  if (heartbeat) clearInterval(heartbeat);
  timer = null;
  heartbeat = null;
}

module.exports = { start, stop, runDaily, scheduleNext, catchUp };
