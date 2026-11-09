'use strict';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { aiKeyPath, ensureDir } = require('./paths');

/**
 * 模型 API Key 的加密存储。
 *
 * Windows 上 safeStorage 走 DPAPI（绑定当前用户账户），密文落到 ai_key.bin。
 * 关键约束：
 * - `safeStorage` 必须在 `app.whenReady()` 之后才可用，所以所有调用都放在运行期，不在模块顶层。
 * - 若系统不支持加密（isEncryptionAvailable() 为 false），**坚决不落明文**，直接报错让用户知情。
 */

function isAvailable() {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function hasKey() {
  try {
    return fs.existsSync(aiKeyPath()) && fs.statSync(aiKeyPath()).size > 0;
  } catch {
    return false;
  }
}

function saveKey(plain) {
  const key = String(plain == null ? '' : plain).trim();
  if (!key) throw new Error('API Key 为空');
  if (!isAvailable()) throw new Error('当前系统不支持加密存储（safeStorage 不可用），拒绝以明文保存密钥');

  const buf = safeStorage.encryptString(key);
  ensureDir(path.dirname(aiKeyPath()));
  fs.writeFileSync(aiKeyPath(), buf, { mode: 0o600 });
  return true;
}

/** 仅在主进程内部调用（发起模型请求时），绝不经 IPC 回传渲染层 */
function loadKey() {
  if (!hasKey()) return null;
  if (!isAvailable()) return null;
  try {
    return safeStorage.decryptString(fs.readFileSync(aiKeyPath()));
  } catch {
    return null;
  }
}

function clearKey() {
  try {
    if (fs.existsSync(aiKeyPath())) fs.rmSync(aiKeyPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 给界面看的掩码：只暴露后 4 位 */
function maskedKey() {
  const key = loadKey();
  if (!key) return '';
  const tail = key.slice(-4);
  return `${'•'.repeat(Math.max(4, Math.min(12, key.length - 4)))}${tail}`;
}

module.exports = { isAvailable, hasKey, saveKey, loadKey, clearKey, maskedKey };
