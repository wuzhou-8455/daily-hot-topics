'use strict';

/**
 * 主进程与渲染进程共享的常量。
 * 渲染进程不得 require 任何 Node 模块，只能从本文件引入纯数据。
 */

/**
 * 九大板块（顺序即界面展示顺序）
 *
 * 为什么「娱乐八卦」和「影视综艺」是一个板块：两者内容高度交叉（明星 → 剧综 → 综艺梗），
 * 拆开会持续产生边界误判，合起来判准率更高。影视/综艺/明星一律归 ent。
 */
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

/** 七个数据源平台 */
const PLATFORMS = [
  { id: 'weibo', name: '微博' },
  { id: 'rednote', name: '小红书' },
  { id: 'zhihu', name: '知乎' },
  { id: 'douyin', name: '抖音' },
  { id: 'toutiao', name: '今日头条' },
  { id: 'baidu', name: '百度' },
  { id: 'quark', name: '夸克' },
];

const PLATFORM_NAME = Object.fromEntries(PLATFORMS.map((p) => [p.id, p.name]));

/** IPC 频道名（集中管理，避免两端写错字符串） */
const CH = {
  dataGetToday: 'data:getToday',
  dataGetByDate: 'data:getByDate',
  dataListDates: 'data:listDates',
  appGetStatus: 'app:getStatus',
  authUnlock: 'auth:unlock',
  authLock: 'auth:lock',
  authSetPassword: 'auth:setPassword',
  authHasPassword: 'auth:hasPassword',
  fetchTrigger: 'fetch:trigger',
  aiInterpret: 'ai:interpret',
  aiPrepare: 'ai:prepare',
  aiCancel: 'ai:cancel',
  evAiProgress: 'ev:aiProgress',
  aiGetConfig: 'ai:getConfig',
  aiSaveKey: 'ai:saveKey',
  exportToday: 'export:today',
  exportReveal: 'export:reveal',
  shellOpenExternal: 'shell:openExternal',
  configGet: 'config:get',
  configSet: 'config:set',
  // 主进程 -> 渲染进程
  evFetchProgress: 'ev:fetchProgress',
  evDataUpdated: 'ev:dataUpdated',
  evError: 'ev:error',
};

const BADGES = {
  new: '新',
  surge: '飙升',
  steady: '持续',
};

module.exports = { BOARDS, BOARD_NAME, PLATFORMS, PLATFORM_NAME, CH, BADGES };
