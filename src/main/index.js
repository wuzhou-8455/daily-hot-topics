'use strict';

const path = require('path');
const { app, BrowserWindow, session, shell, nativeTheme, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');

const { configureProxy } = require('./fetch/proxy');
const { registerIpc } = require('./ipc');
const scheduler = require('./scheduler');
const tray = require('./tray');
const { dateKey } = require('./time');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');
const APP_ORIGIN = 'app://bundle';

/** 无人值守模式：不弹主窗口，走软件渲染，跑完即退出 */
const HEADLESS =
  process.argv.some((a) => a.startsWith('--shot=')) ||
  ['--selftest', '--fetch-once', '--export-once', '--interpret-once'].some((f) =>
    process.argv.includes(f),
  );

/**
 * 数据跟随项目保存：开发态放在项目目录，打包态放在程序目录。
 * 当前 dist/win-unpacked 布局使用项目根目录；单独解压的程序使用 exe 所在目录。
 * --user-data=<目录> 仍可覆盖默认位置，方便隔离测试。
 */
const userDataArg = process.argv.find((a) => a.startsWith('--user-data='));
const userDataOverride = userDataArg && userDataArg.slice('--user-data='.length);
const executableDir = path.dirname(process.execPath);
const isProjectBuild =
  path.basename(executableDir) === 'win-unpacked' &&
  path.basename(path.dirname(executableDir)) === 'dist';
const projectRoot = app.isPackaged
  ? isProjectBuild ? path.resolve(executableDir, '..', '..') : executableDir
  : path.resolve(__dirname, '..', '..');
const dataRoot = userDataOverride
  ? path.resolve(userDataOverride)
  : path.join(projectRoot, 'hotspot-daily');
fs.mkdirSync(dataRoot, { recursive: true });
app.setPath('userData', dataRoot);
app.setPath('sessionData', dataRoot);

/**
 * 某些环境（虚拟机、远程桌面、缺 GPU 相关 DLL 的机器）下 Chromium 的 GPU 进程无法启动，
 * 会直接导致应用退出。此时用 `--disable-gpu` 退回软件渲染即可正常启动。
 * 无人值守模式也走软件渲染，保证验证稳定。
 */
const NO_GPU = HEADLESS || process.argv.includes('--disable-gpu');
if (NO_GPU) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
}

/**
 * 用自定义协议 app:// 加载界面，而不是 file://。
 * 原因：file:// 下页面没有真实 origin，CSP 的 'self' 无法正确匹配，安全策略形同虚设。
 * 注册为 standard + secure 之后，页面拥有稳定 origin，CSP 真正生效。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function isSafeExternal(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function handleAppProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      // app://bundle/index.html -> /index.html
      let rel = decodeURIComponent(url.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const target = path.normalize(path.join(RENDERER_ROOT, rel));
      if (!target.startsWith(RENDERER_ROOT)) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(target)) {
        return new Response('Not Found', { status: 404 });
      }
      return await net.fetch(pathToFileURL(target).toString());
    } catch (err) {
      return new Response(`Error: ${err && err.message}`, { status: 500 });
    }
  });
}

/** 只对 app:// 内部页面注入 CSP（导出稿等本地 HTML 不能被它限制） */
function applyCsp() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!String(details.url || '').startsWith(APP_ORIGIN)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f4f5f7',
    title: '热点日报',
    autoHideMenuBar: true,
    show: !HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  // 渲染层不允许自己开新窗口，所有外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 阻止渲染层被导航离开应用自身
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (isSafeExternal(url)) shell.openExternal(url);
    }
  });

  win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

/** 自检模式：截图存盘并输出诊断信息，便于无人值守验证界面 */
async function runSelfTest(win) {
  // 打包后 __dirname 在 app.asar 内部，是只读的（在里面 mkdir 会 ENOTDIR），
  // 所以打包态把截图写到 userData 下；开发态仍写项目里的 .selftest，方便直接看。
  const outArg = process.argv.find((a) => a.startsWith('--selftest-out='));
  const outDir = outArg
    ? outArg.slice('--selftest-out='.length)
    : app.isPackaged
      ? path.join(app.getPath('userData'), 'selftest')
      : path.join(__dirname, '..', '..', '.selftest');
  fs.mkdirSync(outDir, { recursive: true });
  try {
    /*
     * 纯逻辑断言：日期键偏移（GMT+8 日历日）。
     * 期望值全部手写，**不复用被测函数**——否则实现错了期望值会跟着一起错，断言就白加了。
     * 卡的是 shiftDateKey 曾经差一天：把 +08:00 零点转 UTC 后按 UTC 取日期，days=0 也会退一天。
     */
    const { shiftDateKey } = require('./classifier');
    const dateCases = [
      ['2026-10-10', 0, '2026-10-10'],
      ['2026-10-10', -1, '2026-10-09'],
      ['2026-11-01', -1, '2026-10-31'],
      ['2026-01-01', -1, '2025-12-31'],
      ['2026-12-31', 1, '2027-01-01'],
      ['2024-03-01', -1, '2024-02-29'],
    ];
    const dateFails = dateCases
      .map(([d, n, want]) => ({ d, n, want, got: shiftDateKey(d, n) }))
      .filter((r) => r.got !== r.want);
    console.log(
      '[selftest] date',
      JSON.stringify({ cases: dateCases.length, failed: dateFails.length, fails: dateFails }),
    );

    await new Promise((r) => setTimeout(r, 1800));
    const image = await win.webContents.capturePage();
    const png = path.join(outDir, 'screen.png');
    fs.writeFileSync(png, image.toPNG());
    const info = await win.webContents.executeJavaScript(
      `JSON.stringify({
         title: document.title,
         hasApp: typeof window.hotspot === 'object',
         sections: document.querySelectorAll('[data-board-section]').length,
         cards: document.querySelectorAll('[data-top-card]').length,
         rows: document.querySelectorAll('[data-item-row]').length,
         header: (document.querySelector('[data-el=\"header-line\"]')||{}).textContent || '',
         admin: (document.querySelector('[data-el=\"modal\"]')||{}).hidden === false,
       })`,
    );
    console.log('[selftest] ok', info);

    const shot = async (name, script, waitMs = 800) => {
      if (script) await win.webContents.executeJavaScript(script);
      await new Promise((r) => setTimeout(r, waitMs));
      const p = path.join(outDir, name);
      fs.writeFileSync(p, (await win.webContents.capturePage()).toPNG());
      return p;
    };

    // 平台视图（点「微博」）
    const platPng = await shot(
      'platform.png',
      `(() => {
         const chips = [...document.querySelectorAll('[data-el="subbar"] .chip')];
         const t = chips.find((c) => c.textContent.startsWith('微博'));
         if (t) t.click();
         return true;
       })()`,
    );
    const platInfo = await win.webContents.executeJavaScript(
      `(() => {
         const rows = document.querySelectorAll('[data-el="subbar"] .subrow');
         const last = rows[rows.length - 1];
         const chips = last ? [...last.querySelectorAll('.chip')] : [];
         const sum = chips.reduce((a, c) => {
           const n = c.querySelector('.n');
           return a + (n ? Number(n.textContent) || 0 : 0);
         }, 0);
         const listRows = document.querySelectorAll('[data-el="platform-list"] [data-item-row]').length;
         return JSON.stringify({
           mode: (document.querySelector('.mode-btn.is-on')||{}).textContent,
           title: (document.querySelector('[data-el="platform-title"]')||{}).textContent || '',
           count: (document.querySelector('[data-el="platform-count"]')||{}).textContent || '',
           rows: listRows,
           boardChips: chips.length,
           boardChipSum: sum,
           boardsSectionHidden: document.querySelector('[data-el="boards"]').children.length === 0,
           chipConsistent: sum === listRows && listRows > 0,
         });
       })()`,
    );
    console.log('[selftest] platform', platInfo);

    // 类目视图
    const boardPng = await shot(
      'board.png',
      `(document.querySelector('[data-mode="board"]')||{click(){}}).click(); true`,
    );
    const boardInfo = await win.webContents.executeJavaScript(
      `JSON.stringify({
         mode: (document.querySelector('.mode-btn.is-on')||{}).textContent,
         sections: document.querySelectorAll('[data-board-section]').length,
         rows: document.querySelectorAll('[data-item-row]').length,
         top10Hidden: document.querySelector('[data-el="top10-section"]').hidden,
         firstSection: (document.querySelector('[data-board-section] h2')||{}).textContent || '',
       })`,
    );
    console.log('[selftest] board', boardInfo);

    // 切回平台模式再做管理面板的两张
    await shot('screen.png', `(document.querySelector('[data-mode="platform"]')||{click(){}}).click(); true`);

    // 管理模式面板：闸门态 + 解锁态各一张（解锁只改内存态，不写盘、不设口令）
    await shot(
      'manager.png',
      `(document.querySelector('[data-action="manager"]')||{click(){}}).click(); true`,
      900,
    );
    const mgrInfo = await win.webContents.executeJavaScript(
      `JSON.stringify({
         open: document.querySelector('[data-el="modal"]').hidden === false,
         title: (document.querySelector('[data-el="modal-title"]')||{}).textContent || '',
         inputs: document.querySelectorAll('[data-el="modal-body"] input').length,
         buttons: [...document.querySelectorAll('[data-el="modal-body"] button')].map(b=>b.textContent),
       })`,
    );
    console.log('[selftest] manager', mgrInfo);

    require('./ipc').setAdmin(true);
    const admPng = await shot(
      'manager-admin.png',
      `(document.querySelector('[data-action="modal-close"]')||{click(){}}).click();
       (document.querySelector('[data-action="manager"]')||{click(){}}).click(); true`,
      1100,
    );
    const admInfo = await win.webContents.executeJavaScript(
      `JSON.stringify({
         title: (document.querySelector('[data-el="modal-title"]')||{}).textContent || '',
         buttons: [...document.querySelectorAll('[data-el="modal-body"] button')].map(b=>b.textContent),
         kv: [...document.querySelectorAll('[data-el="modal-body"] dd')].map(d=>d.textContent),
       })`,
    );
    console.log('[selftest] manager-admin', admInfo);
    require('./ipc').setAdmin(false);

    console.log('[selftest] screenshots:', png, platPng, boardPng, admPng);

    // 放在最后抛：这样即使日期断言挂了，前面的截图仍然产出，排查时不用重跑
    if (dateFails.length) {
      throw new Error(`日期偏移断言失败 ${dateFails.length} 例：${JSON.stringify(dateFails)}`);
    }
  } catch (err) {
    console.error('[selftest] failed:', err && err.stack ? err.stack : err);
  } finally {
    app.exit(0);
  }
}

/**
 * 抓取自检模式：跑一次完整流水线，把各源状态与 Top10 打到 stdout。
 * 目的是在无人值守的情况下验证「代理 → 7 源 → 聚类分类 → Top10」整条链路。
 * 不创建窗口，跑完即退出。
 */
async function runFetchOnce() {
  const t0 = Date.now();
  const date = dateKey();
  try {
    const pipeline = require('./pipeline/run');
    const summary = await pipeline.runOnce({
      date,
      onProgress: (p) => {
        if (p.stage === 'source:done') {
          const mark = p.status === 'ok' ? 'OK ' : 'FAIL';
          console.log(
            `[fetch] ${mark} ${p.name} (${p.index}/${p.total}) count=${p.count}` +
              (p.error ? ` err=${p.error}` : ''),
          );
        } else if (p.stage === 'source:start') {
          console.log(`[fetch] ... ${p.name} (${p.index}/${p.total})`);
        } else if (p.stage === 'classify:start') {
          console.log('[fetch] 聚类 / 分类 / 打分 ...');
        }
      },
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[fetch] 完成 date=${summary.date} 用时=${elapsed}s`);
    console.log(
      `[fetch] 条目=${summary.itemCount} 聚类=${summary.clusterCount} 成功源=${summary.okSources}/7`,
    );
    if (summary.failedSources.length) {
      console.log(`[fetch] 失败源：${summary.failedSources.join('、')}`);
    }
    console.log('\n[fetch] Top10：');
    for (const t of summary.top10) {
      console.log(`  ${String(t.rank).padStart(2)}. [${t.board}] ${t.title}  <${t.sources}>`);
    }
    console.log(
      '\n[fetch] RESULT ' +
        JSON.stringify({
          ok: summary.okSources > 0,
          itemCount: summary.itemCount,
          clusterCount: summary.clusterCount,
          okSources: summary.okSources,
          failed: summary.failedSources,
          top10: summary.top10.length,
        }),
    );
  } catch (err) {
    console.error('[fetch] 失败：', err && err.stack ? err.stack : err);
    console.log('[fetch] RESULT ' + JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  } finally {
    app.exit(0);
  }
}

/**
 * 导出一次（无人值守验证用）：跑导出并把结果打到 stdout。
 */
async function runExportOnce() {
  const date = dateKey();
  try {
    const { exportToday } = require('./export/html');
    const res = await exportToday({ date });
    console.log(`[export] 已生成 ${res.filePath}（${(res.bytes / 1024).toFixed(1)} KB）`);
    console.log('[export] RESULT ' + JSON.stringify({ ok: true, filePath: res.filePath, bytes: res.bytes }));
  } catch (err) {
    console.error('[export] 失败：', (err && err.message) || err);
    console.log('[export] RESULT ' + JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  } finally {
    app.exit(0);
  }
}

/**
 * 解读自检模式：只跑「模型解读 + 长尾归类」，把结果打到 stdout，不创建窗口。
 *
 * 便捷测试钩子：若设置了 HOTSPOT_AI_BASE_URL / HOTSPOT_AI_MODEL / HOTSPOT_AI_KEY，
 * 会先把它们写进当前数据目录再跑。配合 `--user-data=<临时目录>` 可完全不碰真实配置。
 * 平时不需要它——界面里的「生成 / 更新解读」走同一段逻辑。
 */
async function runInterpretOnce() {
  console.log('[ai] 已停止：付费解读需在软件界面确认后生成，请使用热点后面的生成解读按钮。');
  app.exit(1);
}

/**
 * 截图模式：加载任意本地 HTML / URL 并截图存盘。
 * 用途是核对「导出给别人的单文件 HTML」长得对不对，与 APP 自身的 --selftest 区分开。
 * 用法：electron . --shot=<绝对路径|url> [--shot-out=<png路径>] [--shot-h=<高度>]
 */
async function runShot() {
  const arg = process.argv.find((a) => a.startsWith('--shot='));
  const outArg = process.argv.find((a) => a.startsWith('--shot-out='));
  const hArg = process.argv.find((a) => a.startsWith('--shot-h='));
  const src = arg ? arg.slice('--shot='.length) : '';
  const out = outArg
    ? outArg.slice('--shot-out='.length)
    : path.join(__dirname, '..', '..', '.tmp', 'shot.png');
  const height = hArg ? Number(hArg.slice('--shot-h='.length)) || 1400 : 1400;

  let target = src;
  if (!/^https?:|^file:/i.test(src)) target = pathToFileURL(path.resolve(src)).toString();

  const win = new BrowserWindow({
    width: 1000,
    height,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await win.loadURL(target);
    await new Promise((r) => setTimeout(r, 1200));
    // 可选：截图前先跑一段页面脚本（用于切到某个视图再拍）
    const evalArg = process.argv.find((a) => a.startsWith('--shot-eval='));
    if (evalArg) {
      const code = evalArg.slice('--shot-eval='.length);
      try {
        await win.webContents.executeJavaScript(code);
        await new Promise((r) => setTimeout(r, 700));
      } catch (err) {
        console.warn('[shot] eval 失败：', (err && err.message) || err);
      }
    }
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    console.log(`[shot] 已保存 ${out}`);
    console.log('[shot] RESULT ' + JSON.stringify({ ok: true, out }));
  } catch (err) {
    console.error('[shot] 失败：', (err && err.stack) || err);
    console.log('[shot] RESULT ' + JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  } finally {
    app.exit(0);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'light';

    handleAppProtocol();
    applyCsp();

    // 代理必须在 app ready 之后配置（Chromium 网络栈此时可用）
    const proxyInfo = await configureProxy();
    console.log(`[proxy] mode=${proxyInfo.mode}${proxyInfo.proxyRules ? ` rules=${proxyInfo.proxyRules}` : ''}`);

    registerIpc(() => mainWindow);

    // 开机自启只在打包后有意义（开发态注册到的是 electron.exe）
    try {
      require('./ipc').applyLoginItem(require('./store/config').load().runAtLogin);
    } catch {
      /* 忽略 */
    }

    // 抓取/导出/截图的无人值守模式不需要主窗口，跑完直接退出
    if (process.argv.some((a) => a.startsWith('--shot='))) {
      await runShot();
      return;
    }
    if (process.argv.includes('--fetch-once')) {
      await runFetchOnce();
      return;
    }
    if (process.argv.includes('--export-once')) {
      await runExportOnce();
      return;
    }
    if (process.argv.includes('--interpret-once')) {
      await runInterpretOnce();
      return;
    }

    mainWindow = createWindow();

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // 关窗口收进托盘而不是退出——否则 08:30 的定时抓取就没了。
    // 但托盘没建起来时绝不能拦：那样窗口一关就再也找不回来（只能去任务管理器杀进程）。
    const wantTray = !HEADLESS && !process.argv.includes('--no-tray');
    let trayOk = false;
    if (wantTray) {
      trayOk = !!tray.create(() => mainWindow);
      if (trayOk) tray.refreshTooltip();
    }

    mainWindow.on('close', (event) => {
      if (trayOk) tray.handleClose(event, mainWindow);
    });

    if (process.argv.includes('--selftest')) {
      mainWindow.webContents.once('did-finish-load', () => runSelfTest(mainWindow));
      return;
    }

    scheduler.start(() => mainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 有托盘时窗口只是被隐藏，这里通常不会触发；触发即意味着要退出（如 --no-tray）
    if (process.platform !== 'darwin' && process.argv.includes('--no-tray')) app.quit();
  });

  app.on('before-quit', () => {
    tray.quitting();
    scheduler.stop();
  });
}
