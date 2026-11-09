'use strict';

const path = require('path');
const fs = require('fs');
const { CH } = require('../shared/constants');
const { dateKey, nextDailyRun } = require('./time');
const daily = require('./store/daily');
const configStore = require('./store/config');
const auth = require('./store/auth');
const secure = require('./store/secure');
const { sampleDigest } = require('./store/sample');

/**
 * 运行期状态（仅内存，不落盘）。
 * isAdmin 只在本次运行内有效，重启即回到只读——这样「管理员闸门」不需要额外的登录态存储。
 */
const state = {
  isAdmin: false,
  fetching: false,
  lastRunAt: null,
  lastRunOk: null,
  lastRunNote: '',
  lastProgress: null,
};

function getState() {
  return state;
}

function setAdmin(v) {
  state.isAdmin = !!v;
}

/** 校验渲染层传来的外部链接：只放行 http/https */
function normalizeExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** 开关开机自启。开发态（未打包）注册的是 electron.exe，没有意义，所以只在打包后生效。 */
function applyLoginItem(enabled) {
  try {
    const { app } = require('electron');
    if (!app.isPackaged) return false;
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
    return true;
  } catch {
    return false;
  }
}

function registerIpc(getWindow) {
  const { ipcMain, shell } = require('electron');

  const ok = (data) => ({ ok: true, data });
  const fail = (error, extra) => ({ ok: false, error: String(error), ...(extra || {}) });
  const guard = () => (state.isAdmin ? null : fail('需要先解锁管理模式'));

  /* ---------------- 榜单数据 ---------------- */

  ipcMain.handle(CH.dataGetToday, () => {
    const today = dateKey();
    const digest = daily.loadDigest(today);
    if (digest) return ok(digest);
    // 当天还没抓到时给样例，界面会标注「样例数据」，避免白屏
    return ok(sampleDigest());
  });

  ipcMain.handle(CH.dataGetByDate, (_e, payload) => {
    const date = payload && payload.date;
    try {
      const digest = daily.loadDigest(date);
      return digest ? ok(digest) : fail('该日期没有数据');
    } catch (err) {
      return fail(err.message);
    }
  });

  ipcMain.handle(CH.dataListDates, () => ok(daily.listDates()));

  /* ---------------- 运行状态 ---------------- */

  ipcMain.handle(CH.appGetStatus, () => {
    const today = dateKey();
    const cfg = configStore.load();
    return ok({
      isAdmin: state.isAdmin,
      hasPassword: auth.hasPassword(),
      hasTodayData: daily.hasDigest(today),
      today,
      lastRunAt: state.lastRunAt,
      lastRunNote: state.lastRunNote,
      nextRunAt: nextDailyRun(cfg.autoFetchHour, cfg.autoFetchMinute),
      fetching: state.fetching,
      keyConfigured: secure.hasKey(),
      encryptionAvailable: secure.isAvailable(),
      modelConfigured: !!(cfg.ai && cfg.ai.model && cfg.ai.baseUrl && secure.hasKey()),
      interpretation: require('./ai/reading-flow').status(),
      autoInterpret: !!(cfg.autoInterpret && cfg.autoInterpretConsent),
      dataRoot: require('./store/paths').userRoot(),
    });
  });

  /* ---------------- 外链 ---------------- */

  ipcMain.handle(CH.shellOpenExternal, async (_e, payload) => {
    const url = normalizeExternalUrl(payload && payload.url);
    if (!url) return fail('链接不可用（只允许 http/https）');
    await shell.openExternal(url);
    return ok({ url });
  });

  ipcMain.handle(CH.exportReveal, (_e, payload) => {
    const p = payload && payload.filePath;
    if (typeof p !== 'string' || !p || !fs.existsSync(p)) return fail('文件不存在');
    shell.showItemInFolder(p);
    return ok({ filePath: p });
  });

  /* ---------------- 设置 ---------------- */

  ipcMain.handle(CH.configGet, () => ok(configStore.load()));

  ipcMain.handle(CH.configSet, (_e, patch) => {
    const g = guard();
    if (g) return g;
    if (!patch || typeof patch !== 'object') return fail('参数不合法');
    const safePatch = { ...patch };
    delete safePatch.confirmationToken;
    delete safePatch.autoInterpretConsent;
    if (patch.autoInterpret === true) {
      try { safePatch.autoInterpretConsent = require('./ai/reading-flow').consentAuto(patch.confirmationToken); }
      catch (error) { return fail(error.message); }
    } else if (patch.autoInterpret === false) { safePatch.autoInterpretConsent = null; }
    const next = configStore.save(safePatch);
    if (Object.prototype.hasOwnProperty.call(patch, 'runAtLogin')) applyLoginItem(next.runAtLogin);
    return ok(next);
  });

  /* ---------------- 口令解锁（P6） ---------------- */

  ipcMain.handle(CH.authHasPassword, () => ok({ has: auth.hasPassword() }));

  ipcMain.handle(CH.authSetPassword, (_e, payload) => {
    const pw = payload && payload.password;
    try {
      if (auth.hasPassword()) {
        // 已有口令时，改密码必须先解锁（或提供旧口令）
        const oldOk =
          state.isAdmin || (payload && payload.oldPassword && auth.verify(payload.oldPassword));
        if (!oldOk) return fail('需要先解锁管理模式才能修改口令');
      }
      auth.setPassword(pw);
      state.isAdmin = true;
      return ok({ isAdmin: true });
    } catch (err) {
      return fail(err.message);
    }
  });

  ipcMain.handle(CH.authUnlock, (_e, payload) => {
    const pw = payload && payload.password;
    if (!auth.hasPassword()) {
      // 还没设过口令：第一次输入即视为设定
      try {
        auth.setPassword(pw);
        state.isAdmin = true;
        return ok({ isAdmin: true, created: true });
      } catch (err) {
        return fail(err.message);
      }
    }
    if (!auth.verify(pw)) {
      state.isAdmin = false;
      return fail('口令不正确');
    }
    state.isAdmin = true;
    return ok({ isAdmin: true });
  });

  ipcMain.handle(CH.authLock, () => {
    state.isAdmin = false;
    return ok({ isAdmin: false });
  });

  /* ---------------- 手动抓取（P2 出口） ---------------- */

  ipcMain.handle(CH.fetchTrigger, async (_e, options) => {
    const g = guard();
    if (g) return g;
    const scheduler = require('./scheduler');
    const date = (options && options.date) || dateKey();
    const res = await scheduler.runDaily('manual', { date });
    if (!res || !res.ok) return fail((res && res.error) || '抓取失败');
    return ok({ date, itemCount: res.itemCount, clusterCount: res.clusterCount, top10: res.top10 });
  });

  /* ---------------- 模型接入（P7） ---------------- */

  ipcMain.handle(CH.aiGetConfig, () => {
    const cfg = configStore.load();
    return ok({
      baseUrl: (cfg.ai && cfg.ai.baseUrl) || '',
      model: (cfg.ai && cfg.ai.model) || '',
      hasKey: secure.hasKey(),
      keyMasked: secure.maskedKey(),
      encryptionAvailable: secure.isAvailable(),
    });
  });

  ipcMain.handle(CH.aiSaveKey, (_e, payload) => {
    const g = guard();
    if (g) return g;
    try {
      const baseUrl = payload && typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : undefined;
      const model = payload && typeof payload.model === 'string' ? payload.model.trim() : undefined;
      const patchAi = {};
      if (baseUrl !== undefined) patchAi.baseUrl = baseUrl;
      if (model !== undefined) patchAi.model = model;
      if (Object.keys(patchAi).length) configStore.save({ ai: patchAi });

      if (payload && payload.clearKey) {
        secure.clearKey();
      } else if (payload && typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
        secure.saveKey(payload.apiKey.trim());
      }
      return ok({ hasKey: secure.hasKey(), keyMasked: secure.maskedKey() });
    } catch (err) {
      return fail(err.message);
    }
  });

  ipcMain.handle(CH.aiPrepare, (_e, payload) => {
    if (payload && payload.kind !== 'single') { const g = guard(); if (g) return g; }
    if (state.fetching) return fail('正在更新榜单，请抓取完成后再解读。');
    try { return ok(require('./ai/reading-flow').prepare(payload || {})); }
    catch (error) { return fail(error.message); }
  });
  ipcMain.handle(CH.aiCancel, (_e, payload) => {
    require('./ai/reading-flow').cancel(payload && payload.token);
    return ok({ cancelled: true });
  });
  ipcMain.handle(CH.aiInterpret, async (_e, payload) => {
    if (state.fetching) return fail('正在更新榜单，请稍后重新确认。');
    try {
      const report = await require('./ai/reading-flow').execute(payload && payload.token, (p) => {
          const win = getWindow && getWindow();
          if (win && !win.isDestroyed()) win.webContents.send(CH.evAiProgress, p);
      });
      const win = getWindow && getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(CH.evDataUpdated, { date: report.date });
      return ok(report);
    } catch (err) {
      return fail((err && err.message) || err);
    }
  });

  /* ---------------- 导出单文件 HTML（P8） ---------------- */

  ipcMain.handle(CH.exportToday, async (_e, payload) => {
    const g = guard();
    if (g) return g;
    try {
      const { exportToday } = require('./export/html');
      const date = (payload && payload.date) || dateKey();
      const res = await exportToday({ date });
      return ok({ ...res, fileName: path.basename(res.filePath) });
    } catch (err) {
      return fail((err && err.message) || err, { sensitive: err && err.sensitive });
    }
  });
}

module.exports = { registerIpc, getState, setAdmin, state, applyLoginItem };
