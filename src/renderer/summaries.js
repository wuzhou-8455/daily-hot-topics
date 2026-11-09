'use strict';

// Pure data helpers are shared by storage, AI prompts, the app and offline export.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.hotspotSummaries = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function plainText(value, limit = 1200) {
    const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const text = String(value || '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
        if (entity[0] !== '#') return entities[entity.toLowerCase()] || match;
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      })
      .replace(/\s+/g, ' ').trim();
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  function sourcesOf(item) {
    return Array.isArray(item.sources) && item.sources.length ? item.sources : [{
      platform: item.platform, name: item.platformName || item.source || '来源',
      title: item.title, url: item.url || '', desc: item.desc, content: item.content,
    }];
  }

  function evidence(item) {
    return sourcesOf(item).map((source, index) => ({
      id: index + 1, platform: source.platform, name: source.name || '来源',
      title: source.title || item.title, url: source.url || '',
      text: plainText(source.desc) || plainText(source.content),
    }));
  }

  // Old digests omitted source excerpts; recover them from the matching saved raw snapshot.
  function hydrate(digest, raw) {
    if (!digest || !raw || !Array.isArray(raw.sources)) return digest;
    const byUrl = new Map();
    const byTitle = new Map();
    for (const source of raw.sources) for (const item of source.items || []) {
      if (item.url) byUrl.set(source.id + '\n' + item.url, item);
      byTitle.set(source.id + '\n' + item.title, item);
    }
    function restore(item, platform, title) {
      const original = (item.url && byUrl.get(platform + '\n' + item.url)) || byTitle.get(platform + '\n' + title);
      if (!original) return;
      if (!item.desc) item.desc = original.desc || null;
      if (!item.content) item.content = original.content || null;
      if (!item.title) item.title = original.title || title;
    }
    for (const item of (digest.top10 || []).concat((digest.boards || []).flatMap(board => board.items || []))) {
      for (const source of item.sources || []) restore(source, source.platform, source.title || item.title);
    }
    for (const platform of digest.platforms || []) for (const item of platform.items || []) {
      restore(item, platform.id, item.title);
      item.platform = platform.id;
      item.platformName = platform.name;
    }
    return digest;
  }

  function setOpen(panel, open) {
    panel.open = !!open;
    const control = panel.querySelector('summary');
    control.setAttribute('aria-expanded', String(panel.open));
    control.querySelector('.summary-action').textContent = panel.open ? '收起' : '展开';
  }

  function createPanel(item, options) {
    function node(tag, cls, text) {
      const result = document.createElement(tag);
      if (cls) result.className = cls;
      if (text != null) result.textContent = text;
      return result;
    }
    const panel = node('details', 'source-summary');
    panel.dataset.summary = '1';
    panel.dataset.summaryKey = options.key;
    panel.dataset.defaultOpen = options.all ? 'all' : 'first-three';
    const control = node('summary', 'summary-control');
    control.append(node('span', '', '摘要'), node('span', 'summary-action', ''));
    panel.appendChild(control);
    const body = node('div', 'summary-content');
    const entries = evidence(item).filter(source => source.text);
    for (const source of entries) {
      const entry = node('section', 'summary-entry');
      const label = node('div', 'summary-label');
      label.append(node('span', '', '来源摘要'), options.link(source));
      entry.append(label, node('p', 'summary-text', source.text));
      body.appendChild(entry);
    }
    if (!entries.length) body.appendChild(node('p', 'summary-empty', '该来源暂未提供摘要，可点击标题或来源查看详情。'));
    if (item.deepReadError) body.appendChild(node('p', 'summary-error', '上次解读请求失败：' + item.deepReadError + (item.deepRead ? '（已保留原解读）' : '')));
    if (item.deepRead) {
      const section = node('section', 'summary-entry ai-entry');
      section.append(node('div', 'summary-label', 'AI 解读'), node('p', 'summary-text', item.deepRead));
      const refs = (item.deepReadSources || []).filter(source => source && source.url);
      if (refs.length) {
        const links = node('div', 'summary-references');
        links.appendChild(node('span', '', '解读依据：'));
        for (const source of refs) links.appendChild(options.link(source));
        section.appendChild(links);
      }
      body.appendChild(section);
    }
    panel.appendChild(body);
    const hasOverride = Object.prototype.hasOwnProperty.call(options.states, options.key);
    setOpen(panel, hasOverride ? options.states[options.key] : options.open);
    control.addEventListener('click', event => {
      event.preventDefault();
      options.states[options.key] = !panel.open;
      setOpen(panel, options.states[options.key]);
    });
    return panel;
  }

  return { plainText, sourcesOf, evidence, hydrate, createPanel, setOpen };
});
