'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { authPath, readJson, writeJsonAtomic, ensureDir, userRoot } = require('./paths');

/**
 * 管理模式口令。
 *
 * 设计取舍：
 * - 不存明文，用 scrypt 派生（N=16384, r=8, p=1, keylen=64），每个口令独立随机盐。
 * - 比对本机口令用 timingSafeEqual，避免逐字节比较泄漏信息。
 * - 这是「本机管理员闸门」，不是网络账号体系：目的是防止随手改配置，不是对抗本地磁盘取证。
 *   真要防取证，密钥就该走 safeStorage（见 store/secure.js），口令哈希本身不设防。
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_LENGTH = 4;
const MAX_LENGTH = 128;

function hasPassword() {
  const rec = readJson(authPath());
  return !!(rec && rec.hash && rec.salt);
}

function setPassword(password) {
  const pw = String(password == null ? '' : password);
  if (pw.length < MIN_LENGTH) throw new Error(`口令至少 ${MIN_LENGTH} 位`);
  if (pw.length > MAX_LENGTH) throw new Error(`口令不能超过 ${MAX_LENGTH} 位`);

  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });

  writeJsonAtomic(authPath(), {
    v: 1,
    algo: 'scrypt',
    ...SCRYPT,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    updatedAt: new Date().toISOString(),
  });
  return true;
}

function verify(password) {
  const rec = readJson(authPath());
  if (!rec || !rec.hash || !rec.salt) return false;

  const pw = String(password == null ? '' : password);
  if (!pw || pw.length > MAX_LENGTH) return false;

  try {
    const salt = Buffer.from(rec.salt, 'base64');
    const expected = Buffer.from(rec.hash, 'base64');
    const actual = crypto.scryptSync(pw, salt, expected.length || SCRYPT.keylen, {
      N: rec.N || SCRYPT.N,
      r: rec.r || SCRYPT.r,
      p: rec.p || SCRYPT.p,
      maxmem: 128 * (rec.N || SCRYPT.N) * (rec.r || SCRYPT.r) * 2,
    });
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 删除口令（开发/重置用；只有已解锁时才允许调用） */
function clearPassword() {
  try {
    if (fs.existsSync(authPath())) fs.rmSync(authPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { hasPassword, setPassword, verify, clearPassword, MIN_LENGTH, MAX_LENGTH, userRoot, ensureDir };
