'use strict';
const { normalizeTitle } = require('../classifier');
const fields = ['deepRead', 'deepReadSources', 'deepReadAt', 'deepReadModel', 'deepReadUsage', 'deepReadStatus', 'deepReadError'];
function keyOf(item) { return item.key || normalizeTitle(item.title); }
function items(digest) {
  return [...(digest.top10 || []), ...(digest.boards || []).flatMap(board => board.items || []), ...(digest.platforms || []).flatMap(platform => platform.items || [])];
}
function apply(digest, key, values) {
  for (const item of items(digest)) if (keyOf(item) === key) Object.assign(item, values);
}
function preserve(next, previous) {
  if (!previous) return next;
  const saved = new Map();
  for (const item of items(previous)) {
    if (!item.deepRead && !item.deepReadStatus && !item.deepReadError) continue;
    const key = keyOf(item);
    if (!saved.has(key) || (!saved.get(key).deepRead && item.deepRead)) {
      saved.set(key, Object.fromEntries(fields.filter(field => item[field] !== undefined).map(field => [field, item[field]])));
    }
  }
  for (const [key, values] of saved) apply(next, key, values);
  return next;
}
module.exports = { keyOf, items, apply, preserve };
