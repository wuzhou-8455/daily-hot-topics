'use strict';

/**
 * 预加载脚本：唯一的主进程通道。
 *
 * 注意：窗口开启了 `sandbox: true`，沙箱化的 preload **只能 require electron / events / timers / url**，
 * 不能 require 相对路径的本地模块。所以频道名在这里就地写死，与 src/shared/constants.js 的 CH 保持一致。
 * 修改频道名时必须同时改这两处。
 */

const { contextBridge, ipcRenderer } = require('electron');

const CH = {
  dataGetToday: 'data:getToday',
  dataGetByDate: 'data:getByDate',
  dataListDates: 'data:listDates',
  appGetStatus: 'app:getStatus',
  authUnlock: 'auth:unlock',
  authLock: 'auth:lock',
  authSetPassword: 'auth:setPassword',
  authHasPassword: 'auth:hasPassword',
  fetchTrigger: 'fetch:trigger',
  aiInterpret: 'ai:interpret',
  aiPrepare: 'ai:prepare',
  aiCancel: 'ai:cancel',
  evAiProgress: 'ev:aiProgress',
  aiGetConfig: 'ai:getConfig',
  aiSaveKey: 'ai:saveKey',
  exportToday: 'export:today',
  exportReveal: 'export:reveal',
  shellOpenExternal: 'shell:openExternal',
  configGet: 'config:get',
  configSet: 'config:set',
  evFetchProgress: 'ev:fetchProgress',
  evDataUpdated: 'ev:dataUpdated',
  evError: 'ev:error',
};

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** 只暴露显式方法，绝不暴露 ipcRenderer 本身 */
contextBridge.exposeInMainWorld('hotspot', {
  // 数据
  getToday: () => invoke(CH.dataGetToday),
  getByDate: (date) => invoke(CH.dataGetByDate, { date }),
  listDates: () => invoke(CH.dataListDates),

  // 状态
  getStatus: () => invoke(CH.appGetStatus),

  // 权限
  hasPassword: () => invoke(CH.authHasPassword),
  setPassword: (password) => invoke(CH.authSetPassword, { password }),
  unlock: (password) => invoke(CH.authUnlock, { password }),
  lock: () => invoke(CH.authLock),

  // 抓取与解读
  triggerFetch: (options) => invoke(CH.fetchTrigger, options),
  prepareInterpretation: (options) => invoke(CH.aiPrepare, options),
  cancelInterpretation: (token) => invoke(CH.aiCancel, { token }),
  runInterpretation: (token) => invoke(CH.aiInterpret, { token }),

  // 模型配置（永不回传 key 明文）
  getAiConfig: () => invoke(CH.aiGetConfig),
  saveApiKey: (payload) => invoke(CH.aiSaveKey, payload),

  // 导出与跳转
  exportToday: () => invoke(CH.exportToday),
  revealExport: (filePath) => invoke(CH.exportReveal, { filePath }),
  openExternal: (url) => invoke(CH.shellOpenExternal, { url }),

  // 设置
  getSettings: () => invoke(CH.configGet),
  setSettings: (patch) => invoke(CH.configSet, patch),

  // 事件订阅（返回取消订阅函数）
  onFetchProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on(CH.evFetchProgress, h);
    return () => ipcRenderer.removeListener(CH.evFetchProgress, h);
  },
  onAiProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on(CH.evAiProgress, h);
    return () => ipcRenderer.removeListener(CH.evAiProgress, h);
  },
  onDataUpdated: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on(CH.evDataUpdated, h);
    return () => ipcRenderer.removeListener(CH.evDataUpdated, h);
  },
  onError: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on(CH.evError, h);
    return () => ipcRenderer.removeListener(CH.evError, h);
  },
});
