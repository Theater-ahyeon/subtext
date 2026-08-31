# Android 版（Capacitor + nodejs-mobile）

知微的业务核心（store/parser/llm/prompts/pipeline/memory/api-core）从第一天就与 Electron 解耦、可在纯 Node 环境运行；渲染层是无构建原味 SPA。因此安卓适配采用**最小改动路径**：

> Node 直接跑在 Android 应用沙箱里（[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)）启动与桌面版同一套 `web/server.js`（仅回环 127.0.0.1:4188），Capacitor WebView 指向该本地地址。**不重写后端、不引入云。**

---

## 三种使用方式（按上手成本排序）

### 方式一 · 手机浏览器访问电脑（零构建，今天就能用）

电脑启动服务并对局域网开放（必须带令牌——原话库/理解卡属私人数据）：

```bash
node web/server.js --host 0.0.0.0 --token 换成一串随机字符
```

手机浏览器打开 `http://<电脑IP>:4188/?token=<同样的随机串>`（令牌会存入 localStorage，之后不用再带）。配合 [PWA manifest](../src/renderer/manifest.webmanifest) 可以"添加到主屏幕"全屏使用。

> ⚠️ 服务无登录体系，令牌是唯一门禁：请使用长随机串，且仅在可信 Wi-Fi 下开放。

### 方式二 · PWA（同方式一，装成"应用"）

同上；Android Chrome → 菜单 →「添加到主屏幕」，即以独立窗口运行（`display: standalone`）。

### 方式三 · 独立 APK（Capacitor + nodejs-mobile）

把 Node 后端装进 APK，完全离线、数据不出手机。构建需要 Android Studio / SDK：

```bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android
npx cap init            # 或直接使用 mobile/capacitor.config.json
npm i nodejs-mobile-capacitor   # 社区插件：在 Android 内运行 Node
npx cap add android
npx cap sync android
```

集成要点（一次性改动，见 mobile/ 目录）：

1. `mobile/capacitor.config.json` —— WebView 指向 `http://127.0.0.1:4188`（cleartext 仅回环）。
2. `mobile/main.js` —— nodejs-mobile 入口：设置 `HABITAT_DATA_DIR`（应用私有 files 目录）与端口后 require `../web/server.js`。
3. `android/app/src/main/AndroidManifest.xml` —— `android:usesCleartextTraffic="true"`（仅回环地址，Capacitor 默认亦允许 localhost）。
4. MainActivity 启动 nodejs-mobile 引擎并把 `filesDir` 传给 `mobile/main.js`（参考 nodejs-mobile-capacitor 插件文档的启动样板）。

```bash
npx cap open android    # Android Studio 内 Build APK
```

> 数据在应用私有目录（`filesDir/subtext/`），卸载即全部删除；与桌面版互不相通（可用理解卡导出/导入搬运）。

---

## 移动端适配范围（本仓库已内置）

- `src/renderer/css/mobile.css` —— ≤820px 断点：侧栏转顶部横排导航、网格堆叠、触控目标加大、模态适配、`100dvh` 动态视口
- `index.html` —— `viewport` meta（device-width, viewport-fit=cover）
- PWA：`manifest.webmanifest` + 图标
- `web/server.js` —— `--host` / `--token` 参数；非回环地址强制要求令牌；API 全部走 Bearer 校验（静态资源公开、数据走鉴权接口）
- 垫片自动携带令牌（`?token=` 首次注入 localStorage）

## 已知差异（与桌面版）

- API Key 加密：Android 无 DPAPI/Keychain，Key 以明文存于应用私有目录 settings.json（与 Web 宿主一致，设置页会如实提示）
- 证据缩略图：无 Electron nativeImage，缩略图 = 原图（store.js 已有降级路径）
- GBK 自动检测依赖完整 ICU：nodejs-mobile 构建若缺 ICU，将退化为 UTF-8 解码（代码已有 try/catch）
- 麦克风/相机等原生能力未接入
