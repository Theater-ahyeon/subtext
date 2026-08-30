# Round 05 · 发布

日期：2026-08-31

## 交付内容

- 完整文档：README（安装/功能/方法论映射/隐私红线/开发/路线图）、CHANGELOG、LICENSE（MIT）、`docs/formats.md`（支持的导出格式对照）、`docs/methodology.md`（方法论映射）
- 版本 v1.0.0，tag 推送触发 CI 三平台构建并自动创建 GitHub Release

## 发布物

| 平台 | 文件 | 构建位置 |
|---|---|---|
| Windows | `Habitat Sandbox Setup 1.0.0.exe` / `Habitat Sandbox-1.0.0-win.zip` | 本机 |
| macOS (Intel + Apple Silicon) | `Habitat Sandbox-1.0.0.dmg` | GitHub Actions |
| Linux | `Habitat Sandbox-1.0.0.AppImage` / `*.deb` | GitHub Actions |

## 上传

- 仓库：`github.com/Theater-ahyeon/habitat-sandbox`（public）
- 提交历史按轮次组织（round-00 → round-05），关键轮次打 tag：`v0.1.0-mvp` → `v0.2.0` → `v0.2.1` → `v1.0.0`
- 推送 tag 后 CI 自动构建三平台安装包并挂到 Release（见 Actions 页）

## 验收清单（醒来后可核对）

- [ ] `npm test` → 24 通过
- [ ] `npm start` → 演示模式全流程：建档案 → 导入样例 → 归纳 → 演练 → 冻结预测 → 回流归因 → 撤销
- [ ] 设置页切换 OpenAI 兼容接口 → 测试连接
- [ ] Releases 页有 Windows/macOS/Linux 安装包
