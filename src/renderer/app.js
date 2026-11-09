'use strict';

/**
 * 渲染进程：只负责展示与交互。
 * 不联网（CSP connect-src 'none'），不持有任何密钥，所有能力通过 window.hotspot 请求主进程。
 */

(function () {
  const api = window.hotspot;
  const summaries = window.hotspotSummaries;
  const summaryStates = Object.create(null);
  let aiPreparing = false;

  const BADGE_TEXT = { new: '新', surge: '飙升', steady: '持续' };

  /**
   * 视图状态。
   * mode = 'platform' ：第一层选平台（全平台T10 / 微博 / 小红书 …），第二层用类目过滤
   * mode = 'board'    ：第一层选类目，按板块分组展示，条目不标类目名、只标来源平台
   */
  const state = {
    digest: null,
    status: null,
    dates: [],
    query: '',
    mode: 'platform', // platform | board
    platform: 'all', // all | weibo | rednote | ...
    board: '', // '' = 全部类目
  };

  const els = {};
  let toastTimer = null;

  // 必须与 src/shared/constants.js 的 BOARDS 保持一致（渲染层不能 require 本地模块）
  const BOARDS = [
    { id: 'society', name: '社会民生' },
    { id: 'ent', name: '娱乐' },
    { id: 'tech', name: '科技数码' },
    { id: 'finance', name: '财经商业' },
    { id: 'sports', name: '体育竞技' },
    { id: 'world', name: '国际时政' },
    { id: 'life', name: '生活种草' },
    { id: 'health', name: '健康养生' },
    { id: 'other', name: '其他' },
  ];
  const BOARD_NAME = Object.fromEntries(BOARDS.map((b) => [b.id, b.name]));

  /**
   * 是否高置信度分类。
   * 旧成稿没有 confidence 字段，此时回退到按来源判断，保证新旧数据观感一致。
   */
  function isHighConfidence(item) {
    if (!item) return false;
    if (item.confidence) return item.confidence === 'high';
    return item.boardSource !== 'prior' && item.boardSource !== 'fallback';
  }

  /* ---------------- 基础工具 ---------------- */

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'hidden') node.hidden = !!v;
        else node.setAttribute(k, String(v));
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function toast(message, kind) {
    const box = els.toast;
    if (!box) return;
    box.textContent = message;
    box.className = 'toast' + (kind ? ` ${kind}` : '');
    box.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.hidden = true;
    }, kind === 'error' ? 8000 : 4200);
  }

  /* ---------------- 渲染 ---------------- */

  function renderHeader() {
    const d = state.digest;
    const st = state.status;
    const line = els.headerLine;

    if (!d) {
      line.textContent = '暂无数据';
      return;
    }
    const parts = [`${d.date}`];
    if (d.generatedAt) parts.push(`更新于 ${String(d.generatedAt).slice(11, 16)}`);
    if (d.generatedBy === 'sample') parts.push('样例数据（尚未抓取）');
    if (d.generatedBy === 'manual') parts.push('手动抓取');
    if (d.generatedBy === 'auto') parts.push('每日自动');
    if (st && st.fetching) parts.push('正在抓取…');
    line.textContent = parts.join(' · ');
  }

  function renderSourceStatus() {
    const box = els.sourceStatus;
    clear(box);
    const d = state.digest;
    if (!d || !Array.isArray(d.sourceStatus)) return;

    for (const s of d.sourceStatus) {
      const ok = s.status === 'ok';
      const title = ok ? `${s.name}：${s.count} 条` : `${s.name}：抓取失败${s.error ? `（${s.error}）` : ''}`;
      box.appendChild(
        el('span', { class: `src ${ok ? 'ok' : 'fail'}`, title }, [
          el('span', { class: 'dot' }),
          el('span', { text: ok ? s.name : `${s.name}（失败）` }),
        ]),
      );
    }
    const failed = d.sourceStatus.filter((s) => s.status !== 'ok');
    if (failed.length) {
      toast(`${failed.length} 个来源抓取失败：${failed.map((s) => s.name).join('、')}`, 'warn');
    }
  }

  /** 主模式按钮的高亮状态 */
  function renderModes() {
    for (const btn of els.modes.querySelectorAll('[data-mode]')) {
      btn.classList.toggle('is-on', btn.dataset.mode === state.mode);
      btn.setAttribute('aria-selected', btn.dataset.mode === state.mode ? 'true' : 'false');
    }
  }

  /**
   * 二级筛选行。
   * - 平台模式：第一行是平台（全平台T10 + 七个平台），第二行是类目（在平台内二次过滤）
   * - 类目模式：只有类目一行
   */
  function renderSubbar() {
    const box = els.subbar;
    clear(box);
    const d = state.digest;
    if (!d) return;

    const platforms = d.platforms || [];

    /**
     * 类目计数的口径必须和当前显示的内容一致。
     * - 选中了具体平台 → 数该平台自己的条目。每条只属于一个板块，所以各计数相加
     *   恰好等于该平台条数（不会出现「显示微博 30、类目加起来 39」）。
     * - 全平台 Top10 / 类目模式 → 数全局成稿（下方那 177 条速览就是它的范围）。
     * 口径不一致会出现「chip 写 社会民生 8、下方分组标题写 社会民生 39」这种自相矛盾。
     */
    const scopedPlatform =
      state.mode === 'platform' && state.platform !== 'all'
        ? platforms.find((p) => p.id === state.platform)
        : null;

    const boardCounts = new Map();
    if (scopedPlatform) {
      for (const it of scopedPlatform.items || []) {
        boardCounts.set(it.board, (boardCounts.get(it.board) || 0) + 1);
      }
    } else {
      for (const b of d.boards || []) boardCounts.set(b.id, (b.items || []).length);
    }

    /** 新建一行筛选：返回放 chips 的容器 */
    const newRow = (label) => {
      const chips = el('div', { class: 'chips' });
      box.appendChild(
        el('div', { class: 'subrow' }, [el('span', { class: 'subbar-label', text: label }), chips]),
      );
      return chips;
    };

    const mkChip = (label, count, isOn, onClick) => {
      const chip = el('button', {
        type: 'button',
        class: `chip${isOn ? ' active' : ''}`,
      }, [label, count != null ? el('span', { class: 'n', text: String(count) }) : null]);
      chip.addEventListener('click', onClick);
      return chip;
    };

    const fillBoardChips = (target) => {
      target.appendChild(
        mkChip('全部', null, state.board === '', () => {
          state.board = '';
          render();
        }),
      );
      for (const b of BOARDS) {
        const n = boardCounts.get(b.id);
        if (!n) continue;
        target.appendChild(
          mkChip(b.name, n, state.board === b.id, () => {
            state.board = state.board === b.id ? '' : b.id;
            render();
          }),
        );
      }
    };

    if (state.mode === 'platform') {
      const pRow = newRow('平台');
      pRow.appendChild(
        mkChip('全平台 Top 10', (d.top10 || []).length, state.platform === 'all', () => {
          state.platform = 'all';
          state.board = '';
          render();
        }),
      );
      for (const p of platforms) {
        pRow.appendChild(
          mkChip(p.name, p.count, state.platform === p.id, () => {
            state.platform = p.id;
            state.board = '';
            render();
          }),
        );
      }
      fillBoardChips(newRow('类目'));
      return;
    }

    fillBoardChips(newRow('类目'));
  }

  function platformTag(src) {
    const node = el('button', {
      type: 'button',
      class: 'pf',
      dataset: { url: src.url || '' },
      title: src.url ? '在浏览器中打开该来源' : '无可用链接',
    }, [
      el('span', { text: src.name }),
      src.hotText ? el('span', { class: 'hot', text: src.hotText }) : null,
    ]);
    if (!src.url) node.disabled = true;
    return node;
  }

  function renderTop10() {
    const box = els.top10;
    clear(box);
    const d = state.digest;
    if (!d) return;
    const list = d.top10 || [];
    els.top10Section.hidden = list.length === 0;

    list.forEach((item, i) => {
      const head = el('div', { class: 'card-head' }, [
        el('span', { class: `rank${i < 3 ? ' top' : ''}`, text: String(i + 1) }),
        el('div', { class: 'card-body' }, [
          el('button', {
            type: 'button',
            class: 'card-title',
            dataset: { url: (item.sources && item.sources[0] && item.sources[0].url) || '' },
            title: '在浏览器中打开来源话题',
            text: item.title,
          }),
          el('div', { class: 'card-meta' }, [
            item.badge ? el('span', { class: `badge ${item.badge}`, text: BADGE_TEXT[item.badge] || '' }) : null,
            // 只有高置信度的分类才标板块：辅助推断与兜底都不标，避免「娱乐：某基建新闻」这类误导
            item.boardName && isHighConfidence(item)
              ? el('span', { class: 'board-tag', text: item.boardName })
              : null,
            ...(item.sources || []).map(platformTag),
          ]),
        ]),
      ]);

      const card = el('article', {
        class: 'card',
        dataset: { topCard: '1', title: item.title, board: item.board || '' },
      }, [head]);
      head.appendChild(readingControls(item));

      card.appendChild(summaryPanel(item, 'top', true));
      box.appendChild(card);
    });
  }

  function summaryPanel(item, scope, all = false) {
    return summaries.createPanel(item, {
      key: `${state.digest.date}:${scope}:${item.key || item.title}`,
      open: all, all, states: summaryStates, link: platformTag,
    });
  }

  function readingControls(item, platform) {
    const job = state.status && state.status.interpretation;
    const key = item.key || item.title;
    const running = !!(job && job.date === state.digest.date && job.keys.includes(key));
    const failed = item.deepReadStatus === 'failed';
    const status = running ? '生成中…' : failed ? (item.deepRead ? '更新失败' : '生成失败') : item.deepRead ? '已完成' : state.status && state.status.modelConfigured ? '待生成' : '模型未配置';
    const button = el('button', { type: 'button', class: 'btn btn-sm ai-item-button', text: running ? '生成中…' : item.deepRead ? '更新解读' : failed ? '重试解读' : '生成解读', dataset: { readingKey: key } });
    button.disabled = !!job;
    button.addEventListener('click', () => requestReading({ kind: 'single', date: state.digest.date, key, platform }));
    return el('div', { class: 'ai-controls' }, [el('span', { class: `ai-status${failed ? ' failed' : ''}`, text: status, title: item.deepReadError || '' }), button]);
  }

  function confirmReading(preview) {
    const dialog = document.querySelector('[data-el="ai-confirm"]');
    document.querySelector('[data-el="ai-confirm-title"]').textContent = preview.kind === 'auto' ? '开启自动解读？' : preview.updating ? '更新这条解读？' : '生成解读？';
    document.querySelector('[data-el="ai-confirm-target"]').textContent = preview.kind === 'auto' ? '每天抓取后，自动补齐全平台 Top10 缺失的解读。' : preview.count === 1 ? preview.titles[0] : `本次补齐 ${preview.count} 条 Top10 解读：${preview.titles.join('；')}`;
    document.querySelector('[data-el="ai-confirm-detail"]').textContent = `模型：${preview.model}。` + (preview.kind === 'auto' ? '开启后每天最多发出一次自动模型请求；失败不自动重试，已有解读不重复生成。' : `${preview.date}，本次最多发送一次模型请求，只处理以上热点。` + (preview.noEvidence ? `其中 ${preview.noEvidence} 条没有来源摘要，解读会说明资料不足。` : ''));
    document.querySelector('[data-el="ai-confirm-fee"]').textContent = preview.kind === 'auto' ? '确认开启后，自动请求由模型服务商按实际用量收费。可以随时在管理模式关闭。' : '确认后才发送请求，费用由模型服务商按实际用量收取。取消不会发送模型请求；请求发出后即使失败也可能已计费。';
    const accept = document.querySelector('[data-el="ai-confirm-accept"]');
    const cancel = document.querySelector('[data-el="ai-confirm-cancel"]');
    accept.textContent = preview.kind === 'auto' ? '确认开启（可能产生费用）' : '确认生成（可能产生费用）';
    return new Promise(resolve => {
      let finished = false;
      const finish = confirmed => {
        if (finished) return;
        finished = true;
        accept.onclick = cancel.onclick = null;
        dialog.removeEventListener('cancel', onCancel);
        dialog.close();
        resolve(confirmed);
      };
      const onCancel = event => { event.preventDefault(); finish(false); };
      accept.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
      cancel.focus();
    });
  }

  async function requestReading(options) {
    if (aiPreparing || document.querySelector('[data-el="ai-confirm"]').open) return;
    aiPreparing = true;
    try {
      const prepared = await api.prepareInterpretation(options);
      if (!prepared || !prepared.ok) { toast((prepared && prepared.error) || '无法准备解读', 'error'); return; }
      const preview = prepared.data;
      if (!preview.needed) { toast('Top10 的解读已经完整，无需再次生成。'); return; }
      const confirmed = await confirmReading(preview);
      if (!confirmed) { await api.cancelInterpretation(preview.token); return; }
      const jobKeys = options.kind === 'single' ? [options.key] : (state.digest.top10 || []).filter(item => !item.deepRead).map(item => item.key);
      state.status.interpretation = { date: options.date, keys: jobKeys, kind: options.kind };
      render();
      const response = await api.runInterpretation(preview.token);
      if (!response || !response.ok) toast((response && response.error) || '解读生成失败；可以再次确认后重试。', 'error');
      else if (response.data.errors.length) toast(response.data.interpreted ? `已生成 ${response.data.interpreted} 条；部分失败：${response.data.errors[0].error}` : `解读生成失败：${response.data.errors[0].error}`, response.data.interpreted ? 'warn' : 'error');
      else toast(`已生成 ${response.data.interpreted} 条解读。`);
      await reload(options.date);
      if (!els.modal.hidden) renderManager();
    } catch (error) {
      toast(error.message || '解读操作失败，请重新确认后重试。', 'error');
      await loadStatus();
      render();
    } finally { aiPreparing = false; }
  }

  /** 单平台视图：该平台自己的原始热榜，按平台自身排名 */
  function renderPlatform() {
    const section = els.platformSection;
    const listBox = els.platformList;
    clear(listBox);

    const d = state.digest;
    const p = d && (d.platforms || []).find((x) => x.id === state.platform);
    if (!p) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    els.platformTitle.textContent = p.name;
    els.platformCount.textContent = `${p.items.length} 条`;

    if (p.status && p.status !== 'ok') {
      listBox.appendChild(
        el('div', { class: 'row' }, [
          el('span', { text: `${p.name} 抓取失败${p.error ? `：${p.error}` : ''}` }),
        ]),
      );
      return;
    }

    p.items.forEach((it) => {
      const row = el('div', {
        class: 'row',
        dataset: { itemRow: '1', title: it.title, board: it.board || '' },
      }, [
        el('span', { class: `row-rank${it.rank <= 3 ? ' hot' : ''}`, text: String(it.rank) }),
        el('button', {
          type: 'button',
          class: 'row-title',
          dataset: { url: it.url || '' },
          title: it.title,
          text: it.title,
        }),
        // 低置信度（辅助推断/兜底）灰化，一眼区分「确定的」和「猜的」
        it.boardName
          ? el('span', {
              class: `row-board${isHighConfidence(it) ? '' : ' low'}`,
              text: it.boardName,
              title: isHighConfidence(it) ? '' : '规则没把握，配好模型后会自动重新判定',
            })
          : null,
        el('span', { class: 'row-hot', text: it.hotText || '' }),
      ]);
      row.appendChild(readingControls(it, p.id));
      row.appendChild(summaryPanel({ ...it, platform: p.id, platformName: p.name }, `platform-${p.id}`));
      listBox.appendChild(row);
    });
  }

  /** 板块维度的排序：热度高的板块排前面 */
  function boardHeat(board) {
    let max = 0;
    for (const it of board.items || []) if ((it.score || 0) > max) max = it.score || 0;
    return max;
  }

  function renderBoards() {
    const box = els.boards;
    clear(box);
    const d = state.digest;
    if (!d) return;

    // 类目模式按板块热度排；平台模式下这只是「其余速览」，保持原顺序即可
    const boards = [...(d.boards || [])];
    if (state.mode === 'board') boards.sort((a, b) => boardHeat(b) - boardHeat(a));

    for (const board of boards) {
      const items = board.items || [];
      const section = el('section', {
        class: 'section',
        id: `board-${board.id}`,
        dataset: { boardSection: board.id },
      }, [
        el('div', { class: 'section-head' }, [
          el('h2', { text: board.name }),
          el('span', { class: 'section-count', text: `${items.length} 条` }),
        ]),
        el('div', { class: 'list' }, items.map((item, i) => {
          const row = el('div', {
            class: 'row',
            dataset: { itemRow: '1', title: item.title, board: item.board || '' },
          }, [
            el('span', { class: 'row-idx', text: String(i + 1) }),
            el('button', {
              type: 'button',
              class: 'row-title',
              dataset: { url: (item.sources && item.sources[0] && item.sources[0].url) || '' },
              title: item.title,
              text: item.title,
            }),
            el('span', { class: 'row-pfs' }, (item.sources || []).map((s) =>
              el('button', {
                type: 'button',
                class: 'pf',
                dataset: { url: s.url || '' },
                title: `打开${s.name}`,
                text: s.name,
              }))),
            el('span', { class: 'row-hot', text: (item.sources && item.sources[0] && item.sources[0].hotText) || '' }),
          ]);
          row.appendChild(readingControls(item));
          row.appendChild(summaryPanel(item, `board-${board.id}`));
          return row;
        })),
      ]);
      box.appendChild(section);
    }
  }

  function renderFooter() {
    const st = state.status;
    if (!st) {
      els.footerLine.textContent = '';
      return;
    }
    const bits = [];
    if (st.lastRunAt) bits.push(`上次运行：${new Date(st.lastRunAt).toLocaleString('zh-CN')}${st.lastRunNote ? `（${st.lastRunNote}）` : ''}`);
    if (st.nextRunAt) bits.push(`下次自动抓取：${new Date(st.nextRunAt).toLocaleString('zh-CN')}`);
    if (st.dataRoot) bits.push(`数据目录：${st.dataRoot}`);
    bits.push(`自动解读：${st.autoInterpret ? '已开启' : '已关闭'}`);
    els.footerLine.textContent = bits.join('　|　');
  }

  function renderDateSelect() {
    const sel = els.dateSelect;
    clear(sel);
    if (!state.dates || state.dates.length <= 1) {
      sel.hidden = true;
      return;
    }
    sel.hidden = false;
    for (const d of state.dates) {
      sel.appendChild(el('option', { value: d, text: d }));
    }
    if (state.digest && state.digest.date) sel.value = state.digest.date;
  }

  function render() {
    renderHeader();
    renderSourceStatus();
    renderModes();
    renderSubbar();

    const d = state.digest;
    const platformMode = state.mode === 'platform';
    const singlePlatform = platformMode && state.platform !== 'all';

    // 单平台视图：只显示该平台的原始榜；类目模式：不显示 Top10（Top10 属于平台模式）
    els.platformSection.hidden = !singlePlatform;
    els.top10Section.hidden = singlePlatform || !platformMode || !(d && (d.top10 || []).length);

    if (singlePlatform) {
      renderPlatform();
    } else {
      // 离开单平台视图时必须清空，否则那些行会残留在 DOM 里被搜索/计数统计到
      clear(els.platformList);
      if (platformMode) renderTop10();
      else clear(els.top10);
    }

    // 选中具体平台时不显示下方那块「全局板块分组」：
    // 它是全平台合并后的聚合，与上面这份平台榜不是同一个范围，
    // 摆在一起会让类目筛选同时作用在两个不同范围上，chip 数字也就没法自洽。
    // （层级分明的替代做法——把该平台内容按类目再分组一遍——会让同一内容出现两次，不取。）
    if (singlePlatform) clear(els.boards);
    else renderBoards();

    renderDateSelect();
    renderFooter();
    applyFilter();
  }

  /* ---------------- 筛选 ---------------- */

  function applyFilter() {
    const q = state.query.trim().toLowerCase();
    const board = state.board;

    const match = (node) => {
      const t = (node.dataset.title || '').toLowerCase();
      const b = node.dataset.board || '';
      if (q && !t.includes(q)) return false;
      if (board && b !== board) return false;
      return true;
    };

    const countVisible = (root, selector) => {
      if (!root) return 0;
      let n = 0;
      for (const node of root.querySelectorAll(selector)) {
        const ok = match(node);
        node.hidden = !ok;
        if (ok) n += 1;
      }
      return n;
    };

    const cards = countVisible(els.top10Section, '[data-top-card]');
    const boardRows = countVisible(els.boards, '[data-item-row]');
    const platformRows = countVisible(els.platformList, '[data-item-row]');

    // Default expansion follows the visible, filtered list; manual choices take precedence.
    for (const list of document.querySelectorAll('.list')) {
      const visibleRows = [...list.querySelectorAll('[data-item-row]:not([hidden])')];
      visibleRows.forEach((row, index) => {
        const panel = row.querySelector('[data-summary]');
        if (!panel || Object.prototype.hasOwnProperty.call(summaryStates, panel.dataset.summaryKey)) return;
        summaries.setOpen(panel, index < 3);
      });
    }

    for (const section of document.querySelectorAll('[data-board-section]')) {
      section.hidden = section.querySelectorAll('[data-item-row]:not([hidden])').length === 0;
    }
    if (els.platformSection && !els.platformSection.hidden) {
      els.platformSection.hidden = platformRows === 0;
    }
    if (els.top10Section) {
      const hasTop = !!(state.digest && (state.digest.top10 || []).length);
      els.top10Section.hidden = els.top10Section.hidden || (hasTop && cards === 0);
    }

    if (els.empty) {
      const total = cards + boardRows + platformRows;
      els.empty.hidden = total > 0;
      if (total === 0) setEmptyMessage();
    }
  }

  /**
   * 空态文案分两种情况，别让人以为「没抓到」：
   * - 当天确实没数据 → 提示去抓取
   * - 有数据但被当前筛选筛空了 → 提示换类目/关键词
   */
  function setEmptyMessage() {
    const d = state.digest;
    if (!d || !(d.top10 || []).length) {
      els.emptyTitle.textContent = '这一天还没有数据。';
      els.emptyHint.textContent = '可用管理模式中的「立即抓取」生成，或等待每天 08:30 的自动抓取。';
      return;
    }
    const p = (d.platforms || []).find((x) => x.id === state.platform);
    const scope = state.mode === 'platform' && p && state.platform !== 'all' ? p.name : '当前筛选';
    if (state.board) {
      els.emptyTitle.textContent = `${scope}里没有「${BOARD_NAME[state.board] || state.board}」的内容。`;
      els.emptyHint.textContent = '换一个类目，或点「全部」看完整榜单。';
      return;
    }
    els.emptyTitle.textContent = '没有匹配的内容。';
    els.emptyHint.textContent = '换个关键词试试。';
  }

  /* ---------------- 数据 ---------------- */

  async function loadStatus() {
    try {
      const r = await api.getStatus();
      if (r && r.ok) state.status = r.data;
    } catch { /* 忽略 */ }
  }
  async function loadToday() {
    const r = await api.getToday();
    if (r && r.ok) state.digest = r.data;
    else toast((r && r.error) || '读取今日数据失败', 'error');
  }

  async function loadDates() {
    try {
      const r = await api.listDates();
      if (r && r.ok) state.dates = r.data || [];
    } catch { /* 忽略 */ }
  }

  async function reload(date = state.digest && state.digest.date) {
    await loadStatus();
    if (date && state.status && date !== state.status.today) {
      const response = await api.getByDate(date);
      if (response && response.ok) state.digest = response.data;
      else await loadToday();
    } else await loadToday();
    await loadDates();
    render();
  }

  /* ---------------- 管理模式 ---------------- */

  const manager = {
    aiConfig: null,
    settings: null,
    busy: false,
    progress: null,
  };

  async function openManager() {
    els.modal.hidden = false;
    manager.progress = null;
    await loadStatus();
    renderManager();
  }

  function closeManager() {
    els.modal.hidden = true;
  }

  function field(labelText, input) {
    return el('div', { class: 'field' }, [el('label', { text: labelText }), input]);
  }

  function textInput(value, placeholder, type) {
    return el('input', {
      type: type || 'text',
      value: value == null ? '' : String(value),
      placeholder: placeholder || '',
      autocomplete: 'off',
      spellcheck: 'false',
    });
  }

  function renderProgress() {
    const p = manager.progress;
    if (!p) return null;
    const wrap = el('div', { class: 'progress' });
    const text =
      p.stage === 'source:done'
        ? `抓取 ${p.name}（${p.index}/${p.total}）· ${p.status === 'ok' ? `${p.count} 条` : '失败'}`
        : p.stage === 'source:start'
          ? `正在抓取 ${p.name}（${p.index}/${p.total}）…`
          : p.stage === 'classify:start'
            ? '正在合并去重、分类、打分…'
            : p.stage === 'ai:interpret:start'
              ? `正在生成 ${p.count} 条解读…`
              : p.stage === 'ai:classify:start'
                ? `正在终审 ${p.count} 条分类（分 ${p.batches} 批）…`
                : p.stage === 'ai:classify:batch'
                  ? `正在终审分类：第 ${p.index}/${p.total} 批`
                  : p.stage === 'ai:skipped'
                    ? p.reason || '未配置模型，已跳过'
                    : p.stage === 'ai:done'
                      ? `解读完成｜终审 ${p.reviewed || 0} 条，改写 ${p.reclassified || 0} 条`
                      : p.stage === 'done'
                        ? `抓取完成（成功 ${p.okCount}/${p.total} 个来源）`
                        : p.stage === 'start'
                          ? '正在启动抓取…'
                          : p.stage || '';
    wrap.appendChild(el('span', { text }));
    if (p.index && p.total) {
      const bar = el('div', { class: 'bar' }, [
        el('i', { style: `width:${Math.round((p.index / p.total) * 100)}%` }),
      ]);
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function renderGate(body, st) {
    const hasPw = !!st.hasPassword;
    body.appendChild(
      el('p', { class: 'group-note', text: hasPw
        ? '请输入管理模式口令。解锁后可以手动抓取、生成解读、导出这一期。'
        : '还没设置口令。设置一个（至少 4 位）用来保护管理操作；口令只存在本机，忘记只能重装或删除数据目录下的 auth.json。' }),
    );

    const pw1 = textInput('', hasPw ? '口令' : '新口令（至少 4 位）', 'password');
    const pw2 = hasPw ? null : textInput('', '再输一次', 'password');
    body.appendChild(field('口令', pw1));
    if (pw2) body.appendChild(field('确认', pw2));

    const btn = el('button', { type: 'button', class: 'btn btn-primary', text: hasPw ? '解锁' : '设置并解锁' });
    const actions = el('div', { class: 'row-actions' }, [btn]);
    body.appendChild(actions);

    const submit = async () => {
      const v = pw1.value;
      if (!v) return toast('请输入口令', 'warn');
      if (pw2 && v !== pw2.value) return toast('两次输入不一致', 'warn');
      btn.disabled = true;
      const r = hasPw ? await api.unlock(v) : await api.setPassword(v);
      btn.disabled = false;
      if (!r || !r.ok) return toast((r && r.error) || '失败', 'error');
      await loadStatus();
      toast(hasPw ? '已解锁管理模式' : '口令已设置，管理模式已解锁');
      renderManager();
      renderFooter();
    };
    btn.addEventListener('click', submit);
    pw1.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    if (pw2) pw2.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    pw1.focus();
  }

  async function renderAdmin(body) {
    if (!manager.aiConfig) {
      const r = await api.getAiConfig();
      if (r && r.ok) manager.aiConfig = r.data;
    }
    if (!manager.settings) {
      const r = await api.getSettings();
      if (r && r.ok) manager.settings = r.data;
    }
    const st = state.status || {};
    const ai = manager.aiConfig || {};

    /* --- 抓取与生成 --- */
    const g1 = el('div', { class: 'group' }, [el('h4', { text: '抓取与生成' })]);
    const fetchBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '立即抓取（重算今天）' });
    const aiBtn = el('button', { type: 'button', class: 'btn', text: '补齐 Top10 解读' });
    const expBtn = el('button', { type: 'button', class: 'btn', text: '导出今天这一期' });
    g1.appendChild(el('div', { class: 'row-actions' }, [fetchBtn, aiBtn, expBtn]));
    if (!ai.hasKey) {
      g1.appendChild(el('p', { class: 'group-note', text: '（尚未配置模型，抓取可用，但「生成解读」需要先填下面的模型信息）' }));
    }
    const progressBox = el('div');
    g1.appendChild(progressBox);

    const startProgress = () => {
      clear(progressBox);
      const p = renderProgress();
      if (p) progressBox.appendChild(p);
    };

    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = aiBtn.disabled = expBtn.disabled = true;
      manager.progress = { stage: 'start' };
      startProgress();
      const r = await api.triggerFetch();
      fetchBtn.disabled = aiBtn.disabled = expBtn.disabled = false;
      manager.progress = r && r.ok ? { stage: 'done', okCount: r.data.okSources, total: 7 } : null;
      startProgress();
      if (!r || !r.ok) toast((r && r.error) || '抓取失败', 'error');
      else toast(`抓取完成：${r.data.itemCount} 条 / 合并后 ${r.data.top10} 条进 Top10`);
      await reload();
      renderManager();
    });

    aiBtn.addEventListener('click', () => requestReading({ kind: 'top10', date: state.digest.date }));

    expBtn.addEventListener('click', async () => {
      expBtn.disabled = true;
      const r = await api.exportToday();
      expBtn.disabled = false;
      if (!r || !r.ok) {
        toast((r && r.error) || '导出失败', 'error');
      } else {
        toast(`已导出：${r.data.fileName}`);
        await api.revealExport(r.data.filePath);
      }
    });

    body.appendChild(g1);

    const autoGroup = el('div', { class: 'group' }, [el('h4', { text: '自动解读' })]);
    const autoCheck = el('input', { type: 'checkbox', dataset: { autoInterpret: '1' } });
    autoCheck.checked = !!manager.settings.autoInterpret;
    autoGroup.appendChild(el('label', { class: 'checkline' }, [autoCheck, el('span', { text: '每天抓取后自动补齐 Top10 解读' })]));
    autoGroup.appendChild(el('p', { class: 'group-note', text: '默认关闭。开启前确认费用；每天最多一次自动模型请求，只补齐缺失解读，失败不自动重试。' }));
    autoCheck.addEventListener('change', async () => {
      const enabled = autoCheck.checked;
      const previous = !!manager.settings.autoInterpret;
      autoCheck.disabled = true;
      try {
        let token;
        if (enabled) {
          const prepared = await api.prepareInterpretation({ kind: 'auto', date: state.status.today });
          if (!prepared || !prepared.ok) throw new Error((prepared && prepared.error) || '无法开启自动解读');
          if (!await confirmReading(prepared.data)) { await api.cancelInterpretation(prepared.data.token); autoCheck.checked = previous; return; }
          token = prepared.data.token;
        }
        const result = await api.setSettings({ autoInterpret: enabled, confirmationToken: token });
        if (!result || !result.ok) throw new Error((result && result.error) || '保存失败');
        manager.settings = result.data;
        await loadStatus();
        renderFooter();
        toast(enabled ? '自动解读已开启，下次抓取后补齐缺失解读。' : '自动解读已关闭。');
      } catch (error) { autoCheck.checked = previous; toast(error.message, 'error'); }
      finally { autoCheck.disabled = false; }
    });
    body.appendChild(autoGroup);

    /* --- 模型设置 --- */
    const g2 = el('div', { class: 'group' }, [el('h4', { text: '模型设置（用于生成解读）' })]);
    if (ai.encryptionAvailable === false) {
      g2.appendChild(el('div', { class: 'warnbox', text: '当前系统不支持加密存储（safeStorage 不可用），为避免明文落盘，程序将拒绝保存 API Key。' }));
    }
    const baseIn = textInput(ai.baseUrl, 'https://api.example.com/v1');
    const modelIn = textInput(ai.model, '例如 hunyuan-turbos-latest');
    const keyIn = textInput('', ai.hasKey ? `已保存 ${ai.keyMasked}（留空则不改）` : '粘贴 API Key', 'password');
    g2.appendChild(field('base_url', baseIn));
    g2.appendChild(field('model', modelIn));
    g2.appendChild(field('api_key', keyIn));
    const saveAi = el('button', { type: 'button', class: 'btn', text: '保存模型设置' });
    const clearKey = el('button', { type: 'button', class: 'btn', text: '清除已存 Key' });
    g2.appendChild(el('div', { class: 'row-actions' }, [saveAi, clearKey]));
    g2.appendChild(el('p', { class: 'group-note', text: 'Key 用系统加密（Windows DPAPI，绑定当前账户）保存，不回传界面、不写入导出的 HTML。' }));

    saveAi.addEventListener('click', async () => {
      saveAi.disabled = true;
      const payload = { baseUrl: baseIn.value.trim(), model: modelIn.value.trim() };
      if (keyIn.value.trim()) payload.apiKey = keyIn.value.trim();
      const r = await api.saveApiKey(payload);
      saveAi.disabled = false;
      if (!r || !r.ok) return toast((r && r.error) || '保存失败', 'error');
      manager.aiConfig = null;
      toast('模型设置已保存');
      renderManager();
    });
    clearKey.addEventListener('click', async () => {
      const r = await api.saveApiKey({ clearKey: true });
      if (!r || !r.ok) return toast((r && r.error) || '清除失败', 'error');
      manager.aiConfig = null;
      toast('已清除 API Key');
      renderManager();
    });

    body.appendChild(g2);

    /* --- 其他 --- */
    const g3 = el('div', { class: 'group' }, [el('h4', { text: '其他' })]);
    const loginChk = el('input', { type: 'checkbox' });
    loginChk.checked = !!(manager.settings && manager.settings.runAtLogin);
    loginChk.addEventListener('change', async () => {
      const r = await api.setSettings({ runAtLogin: loginChk.checked });
      if (!r || !r.ok) {
        toast((r && r.error) || '设置失败', 'error');
        loginChk.checked = !loginChk.checked;
      } else {
        manager.settings = r.data;
      }
    });
    g3.appendChild(el('label', { class: 'checkline' }, [loginChk, el('span', { text: '开机自动启动' })]));

    const dl = el('dl', { class: 'kv' });
    const addKv = (k, v) => {
      dl.appendChild(el('dt', { text: k }));
      dl.appendChild(el('dd', { text: v == null || v === '' ? '—' : String(v) }));
    };
    addKv('数据目录', st.dataRoot);
    addKv('导出目录', (manager.settings && manager.settings.exportDir) || '');
    addKv('下次自动抓取', st.nextRunAt ? new Date(st.nextRunAt).toLocaleString('zh-CN') : '');
    g3.appendChild(dl);

    const lockBtn = el('button', { type: 'button', class: 'btn', text: '锁定（退出管理模式）' });
    lockBtn.addEventListener('click', async () => {
      await api.lock();
      manager.aiConfig = null;
      await loadStatus();
      toast('已退出管理模式');
      renderManager();
      renderFooter();
    });
    g3.appendChild(el('div', { class: 'row-actions' }, [lockBtn]));
    body.appendChild(g3);
  }

  function renderManager() {
    const body = els.modalBody;
    if (!body) return;
    clear(body);
    const st = state.status || {};
    els.modalTitle.textContent = st.isAdmin ? '管理模式 · 已解锁' : '管理模式';
    if (!st.isAdmin) {
      renderGate(body, st);
      return;
    }
    renderAdmin(body);
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    els.headerLine = document.querySelector('[data-el="header-line"]');
    els.sourceStatus = document.querySelector('[data-el="source-status"]');
    els.toast = document.querySelector('[data-el="toast"]');
    els.modes = document.querySelector('[data-el="modes"]');
    els.subbar = document.querySelector('[data-el="subbar"]');
    els.top10 = document.querySelector('[data-el="top10"]');
    els.top10Section = document.querySelector('[data-el="top10-section"]');
    els.platformSection = document.querySelector('[data-el="platform-section"]');
    els.platformList = document.querySelector('[data-el="platform-list"]');
    els.platformTitle = document.querySelector('[data-el="platform-title"]');
    els.platformCount = document.querySelector('[data-el="platform-count"]');
    els.boards = document.querySelector('[data-el="boards"]');
    els.empty = document.querySelector('[data-el="empty"]');
    els.emptyTitle = document.querySelector('[data-el="empty-title"]');
    els.emptyHint = document.querySelector('[data-el="empty-hint"]');
    els.footerLine = document.querySelector('[data-el="footer-line"]');
    els.search = document.querySelector('[data-el="search"]');
    els.dateSelect = document.querySelector('[data-el="date-select"]');
    els.modal = document.querySelector('[data-el="modal"]');
    els.modalTitle = document.querySelector('[data-el="modal-title"]');
    els.modalBody = document.querySelector('[data-el="modal-body"]');

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.modal.hidden) closeManager();
    });

    els.modes.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn || btn.dataset.mode === state.mode) return;
      state.mode = btn.dataset.mode;
      state.board = '';
      if (state.mode === 'board') state.platform = 'all';
      state.query = '';
      els.search.value = '';
      render();
    });

    els.search.addEventListener('input', () => {
      state.query = els.search.value;
      applyFilter();
    });

    els.dateSelect.addEventListener('change', async () => {
      const date = els.dateSelect.value;
      const r = await api.getByDate(date);
      if (r && r.ok) {
        state.digest = r.data;
        render();
      } else {
        toast((r && r.error) || '读取失败', 'error');
      }
    });

    // 统一的外链与操作处理
    document.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-action]');
      if (act) {
        const name = act.dataset.action;
        if (name === 'modal-close') {
          closeManager();
        } else if (name === 'today') {
          await loadStatus();
          await loadToday();
          render();
        } else if (name === 'manager') {
          openManager();
        }
        return;
      }

      const linkish = e.target.closest('[data-url]');
      if (linkish) {
        const url = linkish.dataset.url;
        if (url) {
          const r = await api.openExternal(url);
          if (!r || !r.ok) toast((r && r.error) || '打开链接失败', 'error');
        }
      }
    });

    api.onFetchProgress((p) => {
      if (!p) return;
      // 弹层开着就显示在弹层里，否则只在真正开抓时提示一次
      if (!els.modal.hidden && state.status && state.status.isAdmin) {
        manager.progress = p;
        const box = els.modalBody.querySelector('.progress');
        const fresh = renderProgress();
        if (box && fresh) box.replaceWith(fresh);
        else if (fresh) els.modalBody.appendChild(fresh);
      } else if (p.stage === 'start') {
        toast('正在抓取…');
      }
    });
    api.onAiProgress(async (progress) => {
      if (progress.phase === 'running') {
        state.status.interpretation = { date: progress.date, keys: progress.keys, kind: progress.kind };
        render();
      } else if (state.digest && progress.date === state.digest.date) await reload(progress.date);
      else await loadStatus();
    });
    api.onDataUpdated((event) => {
      if (!event || !state.digest || event.date === state.digest.date) reload();
    });
    api.onError((p) => {
      toast((p && p.message) || '运行出错', 'error');
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!api) {
      document.body.textContent = '预加载脚本未注入（window.hotspot 不存在）';
      return;
    }
    bind();
    await reload();
  });
})();
