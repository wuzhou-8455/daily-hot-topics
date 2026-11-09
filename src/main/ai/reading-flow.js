'use strict';
const crypto = require('crypto');
const path = require('path');
const daily = require('../store/daily');
const readings = require('../store/readings');
const config = require('../store/config');
const secure = require('../store/secure');
const paths = require('../store/paths');
const { dateKey } = require('../time');
const summaries = require('../../renderer/summaries');
const { SYSTEM_INTERPRET, buildTopPrompt, toRows, callModel } = require('./interpret');
const { extractJson } = require('./client');
const confirmations = new Map();
let active = null;

function digestHash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function modelConfig() {
  const cfg = config.load();
  if (!secure.hasKey()) throw new Error('尚未保存 API 密钥，请先在管理模式配置模型。');
  const key = secure.loadKey();
  if (!key) throw new Error('已保存的密钥无法解密，请在管理模式重新保存密钥。');
  if (!cfg.ai || !cfg.ai.model || !cfg.ai.baseUrl) throw new Error('模型设置不完整，请填写服务地址和模型名称。');
  if (!/^https?:\/\//i.test(cfg.ai.baseUrl)) throw new Error('模型服务地址格式不正确。');
  return { model: cfg.ai.model, fingerprint: digestHash([cfg.ai, key]) };
}
function select(options) {
  daily.assertDate(options.date);
  const digest = daily.loadDigest(options.date);
  if (!digest) throw new Error('该日期没有热点数据。');
  if (options.kind === 'top10') return (digest.top10 || []).filter(item => !item.deepRead).map(item => ({ ...item, key: readings.keyOf(item) }));
  const all = readings.items(digest);
  const selected = all.find(item => readings.keyOf(item) === options.key && (!options.platform || item.platform === options.platform));
  if (!selected) throw new Error('这条热点已不在当前榜单，请刷新后重新选择。');
  const global = all.find(item => readings.keyOf(item) === options.key && item.sources && item.sources.length);
  return [{ ...selected, key: readings.keyOf(selected), sources: global ? global.sources : summaries.sourcesOf(selected) }];
}
function snapshot(items) { return digestHash(items.map(item => [item.key, item.title, item.deepRead || '', summaries.evidence(item)])); }
function status() { return active ? { date: active.date, keys: active.keys, kind: active.kind, startedAt: active.startedAt } : null; }
function prepare(options) {
  for (const [token, value] of confirmations) if (value.expiresAt < Date.now()) confirmations.delete(token);
  const kind = options && options.kind || 'single';
  if (!['single', 'top10', 'auto'].includes(kind)) throw new Error('不支持的解读范围。');
  if (active && kind !== 'auto') throw new Error('已有解读正在生成，请等待完成后再操作。');
  const model = modelConfig();
  const date = options.date || dateKey();
  const selection = { kind, date, key: options.key, platform: options.platform };
  const selected = kind === 'auto' ? [] : select(selection);
  if (kind !== 'auto' && !selected.length) return { needed: false, count: 0 };
  const token = crypto.randomUUID();
  confirmations.set(token, { selection, fingerprint: model.fingerprint, snapshot: snapshot(selected), expiresAt: Date.now() + 120000 });
  return { needed: true, token, kind, date, model: model.model, count: selected.length, updating: selected.some(item => !!item.deepRead), titles: selected.map(item => item.title), noEvidence: selected.filter(item => !summaries.evidence(item).some(source => source.text)).length, maxRequests: 1 };
}
function cancel(token) { confirmations.delete(token); }
function consume(token, expectedKind) {
  const approval = confirmations.get(token);
  confirmations.delete(token);
  if (!approval || approval.expiresAt < Date.now()) throw new Error('确认已取消、过期或已使用，请重新点击并确认。');
  if (expectedKind && approval.selection.kind !== expectedKind) throw new Error('确认范围不符。');
  if (modelConfig().fingerprint !== approval.fingerprint) throw new Error('模型设置已改变，请重新确认。');
  return approval;
}
function consentAuto(token) {
  consume(token, 'auto');
  return { version: 1, at: new Date().toISOString(), scope: 'top10-missing', maxRequestsPerDay: 1 };
}
function redactError(error) {
  let message = String(error && error.message || error);
  const key = secure.loadKey();
  if (key) message = message.split(key).join('[密钥已隐藏]');
  return message.slice(0, 500);
}
function progress(callback, phase, operation, extra = {}) {
  try { if (callback) callback({ phase, date: operation.date, keys: operation.keys, kind: operation.kind, ...extra }); }
  catch { /* A closed window must not break job cleanup or trigger another model request. */ }
}
async function generate(selection, selected, onProgress) {
  if (active) throw new Error('已有解读正在生成，请等待完成。');
  const operation = { date: selection.date, kind: selection.kind, keys: selected.map(item => item.key), startedAt: Date.now() };
  const model = modelConfig();
  active = operation;
  const report = { date: selection.date, interpreted: 0, count: selected.length, errors: [], requests: 1, usage: null };
  progress(onProgress, 'running', operation);
  try {
    const indexed = selected.map((item, index) => ({ ...item, rank: index + 1 }));
    // One explicit request. Failed or malformed responses are never automatically retried.
    const response = await callModel({ messages: [{ role: 'system', content: SYSTEM_INTERPRET }, { role: 'user', content: buildTopPrompt({ top10: indexed }) }], maxTokens: selected.length === 1 ? 4096 : 8192 });
    report.usage = response.usage;
    const rows = toRows(extractJson(response.text));
    const byRank = new Map(rows.map(row => [Number(row && row.rank), row]));
    const latest = daily.loadDigest(selection.date);
    if (!latest) throw new Error('生成期间榜单被移除，结果无法保存。');
    indexed.forEach((item, index) => {
      const row = byRank.get(index + 1);
      const value = row && (row.read || row.text || row.content);
      const read = typeof value === 'string' ? value.trim() : '';
      if (!read) {
        const error = '模型未返回这条热点的有效解读；不会自动重试。';
        readings.apply(latest, item.key, { deepReadStatus: 'failed', deepReadError: error });
        report.errors.push({ key: item.key, error });
        return;
      }
      const ids = new Set(Array.isArray(row.sourceIds) ? row.sourceIds.map(Number) : []);
      readings.apply(latest, item.key, { deepRead: read, deepReadSources: summaries.evidence(item).filter(source => ids.has(source.id) && source.text && /^https?:\/\//i.test(source.url)).map(source => ({ name: source.name, url: source.url })), deepReadAt: new Date().toISOString(), deepReadModel: response.model || model.model, deepReadUsage: response.usage || null, deepReadStatus: 'done', deepReadError: '' });
      report.interpreted++;
    });
    daily.saveDigest(selection.date, latest);
    progress(onProgress, report.errors.length ? 'partial' : 'done', operation, report);
    return report;
  } catch (error) {
    const message = redactError(error);
    const latest = daily.loadDigest(selection.date);
    if (latest) { for (const key of operation.keys) readings.apply(latest, key, { deepReadStatus: 'failed', deepReadError: message }); daily.saveDigest(selection.date, latest); }
    progress(onProgress, 'failed', operation, { error: message });
    throw new Error(message);
  } finally { active = null; }
}
async function execute(token, onProgress) {
  const approval = consume(token);
  if (approval.selection.kind === 'auto') throw new Error('自动解读确认只能用于开启设置。');
  const selected = select(approval.selection);
  if (snapshot(selected) !== approval.snapshot) throw new Error('热点内容或解读状态已变化，请重新确认。');
  return generate(approval.selection, selected, onProgress);
}
async function runAuto(date, onProgress) {
  if (date !== dateKey()) return { skipped: true, reason: '历史日期不自动解读' };
  const cfg = config.load();
  if (!cfg.autoInterpret || !cfg.autoInterpretConsent || cfg.autoInterpretConsent.version !== 1) return { skipped: true, reason: '自动解读未开启' };
  if (active) return { skipped: true, reason: '已有解读在进行' };
  const file = path.join(paths.userRoot(), 'data', 'ai-auto', dateKey() + '.json');
  if (paths.readJson(file)) return { skipped: true, reason: '今天的自动请求次数已用完' };
  const selection = { kind: 'top10', date };
  const selected = select(selection);
  if (!selected.length) return { skipped: true, reason: 'Top10 解读已完整' };
  modelConfig();
  // Persist the claim before contacting the provider, including failed/crashed attempts.
  paths.writeJsonAtomic(file, { date, startedAt: new Date().toISOString(), requests: 1 });
  return generate({ ...selection, kind: 'automatic' }, selected, onProgress);
}
module.exports = { prepare, cancel, execute, consentAuto, runAuto, status, isBusy: () => !!active };
