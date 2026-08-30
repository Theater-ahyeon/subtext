# 启用三平台 CI 构建（macOS / Linux 安装包）

仓库的 GitHub Actions workflow 已就绪，位于 [`ci/release.yml`](../ci/release.yml)。
由于创建仓库所用的 token 没有 `workflow` scope（GitHub 规定：推送 `.github/workflows/` 下的文件需要该权限），暂时放在 `ci/` 目录。启用只需三步：

```bash
# 1. 给 gh 补上 workflow 权限（会打开浏览器授权一次）
gh auth refresh -h github.com -s workflow

# 2. 把 workflow 移回官方位置
mkdir -p .github/workflows
git mv ci/release.yml .github/workflows/release.yml
git commit -m "ci: enable three-platform build workflow"

# 3. 推送并重打 tag 触发构建
git push origin main
git tag -f v1.0.0 && git push -f origin v1.0.0
```

tag 推送后 Actions 会自动：
1. 在 Windows / macOS / Ubuntu 三平台并行构建；
2. 跑一遍单元测试；
3. 把 `*.exe` / `*.dmg` / `*.AppImage` / `*.deb` / `*.zip` 全部挂到 v1.0.0 的 Release 页（Windows 包已在发布页，CI 会补充另外两个平台）。

> 手动触发：workflow 也支持 `workflow_dispatch`，在 Actions 页点 "Run workflow" 即可。
