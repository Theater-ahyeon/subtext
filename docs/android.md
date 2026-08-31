# 安卓 / 移动端适配

知微在 v1.3.0 起支持移动端。按上手成本有三条路径（详见 [mobile/README.md](../mobile/README.md)）：

1. **手机浏览器访问电脑**（零构建）：`node web/server.js --host 0.0.0.0 --token <随机串>`，手机打开 `http://<电脑IP>:4188/?token=<随机串>`。
2. **PWA 添加到主屏幕**：同上，Android Chrome「添加到主屏幕」后独立窗口运行。
3. **独立 APK**：Capacitor + nodejs-mobile 把 Node 后端装进应用沙箱，完全离线（构建需 Android Studio，步骤见 mobile/README.md）。

安全要点：服务无登录体系，对局域网开放时 `--token` 为强制项（非回环地址缺令牌将拒绝启动）；令牌经 `?token=` 首次注入 localStorage，之后由垫片随 API 携带。
