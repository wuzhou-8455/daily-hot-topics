# 热点日报

热点日报是一款 Windows 桌面应用，汇总微博、小红书、知乎、抖音、头条、百度和夸克的热点。可按平台和板块浏览，也可以导出单文件 HTML 日报。

## 从源码运行

安装 Node.js 和 npm，然后在项目目录执行。

```sh
npm ci
npm start
```

运行 `npm run selftest` 可用样例数据检查界面。运行 `npm run dist:zip` 可生成 Windows ZIP 包。

## 配置 AI 解读

在应用的管理模式中填写兼容接口地址、模型名和自己的 API 密钥。应用通过 Electron 的 `safeStorage` 将密钥加密保存到本地。请将运行时生成的 `hotspot-daily/` 数据目录留在本机。
