'use strict';
/**
 * 知微 · Android 启动器（nodejs-mobile 入口）。
 * 在 Android 应用沙箱内启动与桌面版完全同一套业务核心（web/server.js），
 * WebView 由 Capacitor 指向 http://127.0.0.1:4188（见 mobile/capacitor.config.json）。
 *
 * 由 nodejs-mobile 的启动脚本以本文件为入口执行：
 *   - 数据目录由 MainActivity 通过 intent extra / 环境变量传入（应用私有 files 目录）
 *   - 端口固定 4188（仅回环监听，不对外）
 */
const path = require('path');
const fs = require('fs');

// nodejs-mobile 会注入 mobile 目录为 cwd；数据目录 = 应用 filesDir/subtext
const dataDir = (typeof global.__FILES_DIR === 'string' && global.__FILES_DIR)
  ? path.join(global.__FILES_DIR, 'subtext')
  : path.join(process.cwd(), 'subtext-data');
fs.mkdirSync(dataDir, { recursive: true });

process.env.HABITAT_DATA_DIR = dataDir;
process.env.HABITAT_WEB_PORT = '4188';

// 与桌面版同一业务核心
require('../web/server.js');
