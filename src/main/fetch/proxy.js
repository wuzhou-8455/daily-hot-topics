'use strict';

const { session } = require('electron');

/**
 * 代理配置。
 *
 * 关键约束：本机（以及很多公司/校园网络）的代理地址是**动态的**，端口每次会话都可能变化，
 * 因此绝不硬编码，只在运行时读取环境变量。
 *
 * 抓取统一走 Electron `net.fetch`（Chromium 网络栈），它天然支持系统代理 / PAC / wpad；
 * 只有在环境变量显式给出代理时才覆盖成该代理。
 */

function readEnvProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  // Chromium 的 proxyRules 需要带协议头
  return /^[a-z]+:\/\//i.test(v) ? v : `http://${v}`;
}

/** 在 app ready 之后调用。返回实际生效的模式，便于日志排查。 */
async function configureProxy() {
  const envProxy = readEnvProxy();
  try {
    if (envProxy) {
      await session.defaultSession.setProxy({ proxyRules: envProxy });
      return { mode: 'env', proxyRules: envProxy };
    }
    await session.defaultSession.setProxy({ mode: 'system' });
    return { mode: 'system' };
  } catch (err) {
    return { mode: 'system', error: String((err && err.message) || err) };
  }
}

/** 诊断/排障用：临时切到直连或指定代理 */
async function overrideProxy(rules) {
  if (rules) {
    await session.defaultSession.setProxy({ proxyRules: rules });
    return { mode: 'custom', proxyRules: rules };
  }
  await session.defaultSession.setProxy({ mode: 'direct' });
  return { mode: 'direct' };
}

module.exports = { configureProxy, overrideProxy, readEnvProxy };
