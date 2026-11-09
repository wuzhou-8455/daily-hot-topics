'use strict';

const fs = require('fs');
const path = require('path');
const { rawDir, digestDir, ensureDir, writeJsonAtomic, readJson } = require('./paths');
const summaries = require('../../renderer/summaries');
const readings = require('./readings');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(date) {
  if (!DATE_RE.test(String(date || ''))) {
    throw new Error(`非法日期: ${date}`);
  }
}

function digestFile(date) {
  assertDate(date);
  return path.join(digestDir(), `${date}.json`);
}

function rawFile(date) {
  assertDate(date);
  return path.join(rawDir(), `${date}.json`);
}

function saveDigest(date, digest) {
  return writeJsonAtomic(digestFile(date), digest);
}

function loadDigest(date) {
  const digest = summaries.hydrate(readJson(digestFile(date)), loadRaw(date));
  if (digest) for (const item of readings.items(digest)) if (!item.key) item.key = readings.keyOf(item);
  return digest ? readings.preserve(digest, digest) : null;
}

function hasDigest(date) {
  try {
    assertDate(date);
    return fs.existsSync(digestFile(date));
  } catch {
    return false;
  }
}

function saveRaw(date, raw) {
  return writeJsonAtomic(rawFile(date), raw);
}

function loadRaw(date) {
  return readJson(rawFile(date));
}

/** 已有成稿的日期列表，倒序（最新在前） */
function listDates() {
  try {
    const dir = ensureDir(digestDir());
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && DATE_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

module.exports = {
  assertDate,
  digestFile,
  rawFile,
  saveDigest,
  loadDigest,
  hasDigest,
  saveRaw,
  loadRaw,
  listDates,
};
