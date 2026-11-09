'use strict';

const { net } = require('electron');

/**
 * OpenAI 兼容的对话补全客户端。
 *
 * 为什么不用 Node 全局 fetch：走 `net.fetch`（Chromium 网络栈）可自动继承系统代理 / PAC，
 * 这对国内直连不通、必须走代理的模型服务是刚需（同 fetch/httpClient.js 的理由）。
 *
 * 只支持「一个 base_url + 一个 key + 一个 model」的最小形态，兼容 OpenAI / 混元 / 通义 / DeepSeek 等。
 */

const DEFAULT_TIMEOUT_MS = 120000;

class AiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.body = body;
  }
}

function normalizeBaseUrl(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new AiError('未配置 base_url');
  if (!/^https?:\/\//i.test(b)) throw new AiError('base_url 必须以 http:// 或 https:// 开头');
  return b;
}

/**
 * @param {Object} opts
 * @param {string} opts.baseUrl 形如 https://api.example.com/v1
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {string} [opts.effort] 推理强度 low/high/max（仅部分服务商支持）
 * @returns {Promise<{text:string, usage:Object|null, model:string}>}
 */
async function chat({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature = 0.4,
  maxTokens = 4096,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  jsonMode = false,
  effort,
}) {
  if (!apiKey) throw new AiError('未配置 API Key');
  if (!model) throw new AiError('未配置模型名');

  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  // 推理强度（low/high/max）。不是所有服务商都认这个字段，所以只在显式配置时才带上，
  // 免得默认请求被某些中转以「未知参数」为由拒绝。
  if (effort) body.effort = effort;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  let text;
  try {
    res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new AiError(`模型请求超时（${Math.round(timeoutMs / 1000)}s）`);
    throw new AiError(`模型请求失败：${(err && err.message) || err}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    let hint = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      hint = (j && j.error && (j.error.message || j.error.code)) || hint;
    } catch {
      /* 非 JSON 错误体，原样截断 */
    }
    throw new AiError(`模型返回 HTTP ${res.status}：${hint}`, res.status, text);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiError('模型返回的不是合法 JSON');
  }

  const choice = parsed && parsed.choices && parsed.choices[0];
  const content =
    (choice && choice.message && choice.message.content) ||
    (choice && choice.text) ||
    '';
  if (!content) throw new AiError('模型返回内容为空');

  return { text: String(content), usage: parsed.usage || null, model: parsed.model || model };
}

/**
 * 从模型回复里抠出 JSON。模型经常包一层 ```json 或加前后说明，这里做容错。
 */
function extractJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试截取首尾括号 */
  }

  const first = s.search(/[[{]/);
  if (first === -1) throw new AiError('模型回复中找不到 JSON');
  const opener = s[first];
  const closer = opener === '{' ? '}' : ']';
  const last = s.lastIndexOf(closer);
  if (last <= first) throw new AiError('模型回复中的 JSON 不完整');
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (err) {
    throw new AiError(`模型回复的 JSON 解析失败：${err.message}`);
  }
}

module.exports = { chat, extractJson, AiError, normalizeBaseUrl };
