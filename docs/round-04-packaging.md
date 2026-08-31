# Round 04 · 跨平台打包

日期：2026-08-31

## 目标

最终版支持三大操作系统，每个系统有安装包。

## 方案

- **electron-builder 25** + `electron-builder.yml` 声明式配置
- Windows：本机构建（NSIS 安装向导 + 便携 zip，x64）
- macOS：CI 构建（dmg，x64 + arm64 双架构，`identity: null` 跳过签名）
- Linux：CI 构建（AppImage + deb）
- **GitHub Actions**（`.github/workflows/release.yml`）：tag 推送 → 三平台并行构建 → 单测 → 上传 artifacts → 自动创建 Release 并附全部安装包

## 应用图标

`build/make-icon.ps1`（PowerShell + System.Drawing 纯代码生成）：墨底圆角方块 + 琥珀-玉色双生水滴（水滴意象），512×512 PNG，electron-builder 自动转换为 ico/icns。

过程中踩坑：PS 5.1 将无 BOM 的 UTF-8 脚本按 GBK 解析，中文注释破坏语法 —— 已重存为带 BOM。

## Windows 本机构建踩坑与解决

**问题**：electron-builder 在非管理员 Windows 上解压 `winCodeSign-2.6.0.7z` 失败——压缩包内两个 darwin 符号链接（libcrypto.dylib / libssl.dylib）需要 SeCreateSymbolicLinkPrivilege。

**解决**：手动预填充缓存 —— 下载 7z 后用 7za 解压到 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0`，忽略两个 darwin 符号链接的失败（Windows 打包只使用其中 rcedit 与 windows-10 签名工具目录）。此后构建正常。

**产物**（v1.0.0）：
- `Rehearsal Setup 1.0.0.exe`（NSIS 安装向导，桌面/开始菜单快捷方式，可选安装目录）
- `Rehearsal-1.0.0-win.zip`（便携版）

## 其他配置

- NSIS 中文快捷方式/卸载显示名（演练）
- `files` 排除 docs/tests，asar 打包
- CI 中 `CSC_IDENTITY_AUTO_DISCOVERY: false` 跳过 macOS 签名探测
- CI 使用 npmmirror Electron 镜像加速

## 验证

- 本地 `npx electron-builder --win nsis zip` → EXIT:0，两个产物生成
- CI workflow 语法与产物路径核对（tag 推送后可在 Actions 页查看三平台构建）
