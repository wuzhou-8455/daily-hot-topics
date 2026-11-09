'use strict';

const path = require('path');
const { app, Tray, Menu, nativeImage, BrowserWindow } = require('electron');
const { dateKey } = require('./time');

/**
 * 托盘常驻。
 *
 * 为什么需要它：数据是「每天 08:30 自动抓取」的，如果关掉窗口就退出进程，定时器也就没了，
 * 早上八点半根本不会跑。所以关窗口 = 收进托盘（进程继续），要真正退出得走托盘菜单。
 *
 * 托盘菜单里保留「立即抓取」，因为它等价于定时任务，不涉及改配置，不需要管理员闸门。
 */

let tray = null;
let isQuitting = false;
let getWin = null;

function iconPath() {
  return path.join(__dirname, 'assets', 'tray.png');
}

function showWindow() {
  const win = getWin && getWin();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: '打开热点日报', click: showWindow },
    { type: 'separator' },
    {
      label: '立即抓取',
      click: async () => {
        showWindow();
        const scheduler = require('./scheduler');
        await scheduler.runDaily('tray');
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function create(getWinFn) {
  getWin = getWinFn;
  if (tray) return tray;

  try {
    const img = nativeImage.createFromPath(iconPath());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    const size = img.getSize();
    console.log(
      `[tray] 已创建${img.isEmpty() ? '（图标为空，将显示为空白占位）' : `（图标 ${size.width}x${size.height}）`}`,
    );
  } catch (err) {
    console.warn('[tray] 创建失败：', (err && err.message) || err);
    return null;
  }

  tray.setToolTip('热点日报');
  tray.setContextMenu(buildMenu());
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  return tray;
}

/** 关窗时调用：返回 true 表示已拦下（改为隐藏到托盘） */
function handleClose(event, win) {
  if (isQuitting) return false;
  event.preventDefault();
  if (win && !win.isDestroyed()) win.hide();
  return true;
}

/** 提示今日是否已有数据（托盘 tooltip 用，纯装饰） */
function refreshTooltip() {
  if (!tray) return;
  try {
    const daily = require('./store/daily');
    const today = dateKey();
    const d = daily.loadDigest(today);
    const n = d && d.stats ? d.stats.clusters : 0;
    tray.setToolTip(d ? `热点日报 · ${today} · ${n} 条` : '热点日报 · 今天还没有数据');
  } catch {
    /* 忽略 */
  }
}

function destroy() {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

function quitting() {
  isQuitting = true;
}

module.exports = { create, handleClose, refreshTooltip, destroy, quitting, showWindow, get tray() { return tray; } };
