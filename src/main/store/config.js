'use strict';

const path = require('path');
const { app } = require('electron');
const { configPath, readJson, writeJsonAtomic } = require('./paths');

/** 非敏感设置。模型 api_key 不在这里（走 safeStorage 加密单独存）。 */

function defaults() {
  let desktop = '';
  try {
    desktop = app.getPath('desktop');
  } catch {
    desktop = '';
  }
  return {
    exportDir: desktop ? path.join(desktop, '热点日报') : '',
    autoFetchHour: 8,
    autoFetchMinute: 30,
    runAtLogin: true,
    autoInterpret: false,
    autoInterpretConsent: null,
    ai: {
      baseUrl: '',
      model: '',
      // 推理强度 low/high/max；留空用服务商默认（deepseek-flash 默认 high）
      effort: '',
    },
  };
}

function load() {
  const saved = readJson(configPath());
  const base = defaults();
  if (!saved || typeof saved !== 'object') return base;
  return {
    ...base,
    ...saved,
    ai: { ...base.ai, ...(saved.ai || {}) },
  };
}

function save(patch) {
  const next = { ...load(), ...(patch || {}) };
  if (patch && patch.ai) next.ai = { ...load().ai, ...patch.ai };
  writeJsonAtomic(configPath(), next);
  return next;
}

module.exports = { load, save, defaults };
