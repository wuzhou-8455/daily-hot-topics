'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * 数据落盘位置。默认放在 Electron 的 userData 目录（升级/换目录不会丢），
 * 全部路径集中在此，方便日后做成可配置。
 */

function userRoot() {
  return app.getPath('userData');
}

/** 各平台原始响应快照 */
function rawDir() {
  return path.join(userRoot(), 'data', 'raw');
}

/** 每日成稿（九板块 + Top10 + 速览） */
function digestDir() {
  return path.join(userRoot(), 'data', 'digest');
}

function configPath() {
  return path.join(userRoot(), 'config.json');
}

function authPath() {
  return path.join(userRoot(), 'auth.json');
}

function aiKeyPath() {
  return path.join(userRoot(), 'ai_key.bin');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 原子写：先写临时文件再替换，避免下游读到半截 JSON */
function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  userRoot,
  rawDir,
  digestDir,
  configPath,
  authPath,
  aiKeyPath,
  ensureDir,
  writeJsonAtomic,
  readJson,
};
