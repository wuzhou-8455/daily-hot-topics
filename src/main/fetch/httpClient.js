'use strict';

const { net } = require('electron');

/**
 * HTTP 客户端。
 *
 * 为什么用 Electron 的 `net.fetch` 而不是 Node 全局 fetch：
 * 本机（以及不少公司/校园网络）的代理是动态的、端口每次会话都变，而且 Chromium 的网络栈
 * 天然支持系统代理 / PAC / wpad。统一走 net.fetch，就不需要在代码里硬编码任何代理地址。
 *
 * 注意：`net` 只能在 app ready 之后使用。
 */

const DEFAULT_TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [1000, 3000, 8000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * Math.max(180, Math.min(600, ms * 0.3)));
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      headers: {
        Accept: accept || 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HotspotDaily/0.1',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
    return await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new HttpError(`请求超时（${timeoutMs}ms）`, undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 是否值得重试：429（频控）、5xx、以及网络层错误（无 status） */
function isRetryable(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  if (typeof err.status === 'number') return err.status >= 500 && err.status < 600;
  return true; // 无 status：连接失败 / 超时 / DNS
}

/**
 * 带重试与指数退避的 JSON GET。
 * 仅对 429 / 5xx / 网络错误重试；其余 4xx 立即失败，不浪费额度。
 */
async function getJson(url, options = {}) {
  const { retries = 2, onAttempt, ...rest } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      if (onAttempt) onAttempt(attempt);
      const text = await fetchText(url, rest);
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      const canRetry = isRetryable(err) && attempt <= retries;
      if (!canRetry) break;
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      await sleep(jitter(delay));
    }
  }

  throw lastError || new Error('请求失败');
}

module.exports = { getJson, fetchText, HttpError, sleep };
