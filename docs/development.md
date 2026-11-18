# 开发与打包

应用使用 Python、FastAPI、HTTPX 和 SQLite，前端为原生 HTML / CSS / JavaScript，无需前端构建。

## 从源码运行

需要 Python 3.10 或更新版本。Windows 可直接运行仓库中的 `Start Farida.cmd`，或手动创建环境：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -X utf8 -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -X utf8 -m pytest -q
.\.venv\Scripts\python.exe -X utf8 run.py
```

Linux / macOS 使用 `python3` 和 `.venv/bin/python`。测试使用离线数据，不需要哔哩哔哩登录。
源码方式保留终端输出；Windows EXE 不显示终端。关闭最后一个应用标签页约 5 秒后自动退出，也可从账号菜单或登录界面选择「退出应用」。
每个页面通过同源 WebSocket 保持连接，不使用后台标签页定时心跳。刷新和页面恢复会重新连接，退出时沿用正常采集清理流程。

应用只监听 `127.0.0.1`，默认端口为 8765；端口被占用时自动选择并记住其他端口。
可用 `--port` 指定端口，`--data-dir` 指定独立数据目录，`--no-browser` 不打开浏览器，
`--no-startup-scan` 暂停该次启动的自动采集。后者仍要求验证登录。
普通启动在 60 秒内没有页面连接时会退出；`--no-browser` 允许没有页面的维护操作，但首次打开页面后，最后一个页面关闭仍会自动退出。

配置示例见 [`config.example.env`](../config.example.env)，该文件不会自动加载。
数据目录默认为 Windows 的 `%LOCALAPPDATA%\FaridaSongBrowser`，或其他系统的
`$XDG_DATA_HOME/farida-song-browser`（未设置时为 `~/.local/share/farida-song-browser`）。
EXE 的诊断输出保存在数据目录下的 `launcher.log`。备份前先退出应用，再复制整个数据目录。

## 播放与本地歌单

`/api/play-queue` 按当前筛选与排序返回完整本地目录，不受界面分页限制。自建歌单及歌曲顺序保存在 SQLite 的
`playlists` / `playlist_items` 表；它们不包含在公开目录导出或发行包中。

播放器使用原生 `<video>`，在实际 `ended` 事件后切换下一段或下一首，不按歌曲时长倒计时。
只有当前歌曲会请求播放信息；取消过时请求，遇到限流暂停队列。暂不支持的格式保留打开原视频入口。
临时连接故障最多自动刷新一次播放地址，并恢复当前分段与位置；手动重试也保留进度。
开启「跳过失效」后只跳过已确认不可用或不支持的歌曲；整队列不可用时停止，避免循环请求。
媒体错误分类通过本地 `/api/playback/status/{key}` 查询，不额外请求哔哩哔哩。
`backend/farida/playback.py` 通过已登录账号获取 MP4 播放信息；Cookie 只发送给 Bilibili API。
浏览器只接收临时本机媒体地址。后端验证 CDN 主机、转发单段 Range 请求，并在内存中流式传输，
不保存视频文件、不向 CDN 发送账号 Cookie。退出或切换账号会撤销本机播放地址。

`scripts/playback_browser_qa.cjs` 使用 Playwright 与 Edge，在独立数据目录中生成短测试视频，模拟播放接口并验证真实结束事件。
第一个参数可指定 Playwright 包路径，第二个参数可指定最终 EXE；不传 EXE 时测试源码启动器。

## 本机设置与备份

`playback_state` 保存队列与偏好，`playback_progress` 记录当前播放位置。读取进度和导出备份时合并两者。
最近播放按歌曲去重，保留最近 100 首，只在浏览器实际开始播放后记录。
迷你播放条复用同一个视频元素，出现与收起均不会重新请求媒体或创建第二路声音。
歌单拖动使用原列表索引，筛选时也保留隐藏歌曲；原有上下移按钮仍可使用。

手动 JSON 备份格式 v2 包含最近播放，兼容恢复不含历史记录的 v1 文件。
恢复前会生成恢复副本；不包含登录凭据。自动每日备份尚未启用。

## 构建 Windows EXE

使用 Windows x64、Python 3.12。运行时依赖锁定在 `requirements-lock.txt`，构建依赖锁定在 `requirements-build.txt`。

```powershell
py -3.12 -m venv .build-venv
.\.build-venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.build-venv\Scripts\python.exe -X utf8 scripts\build_windows.py
.\.build-venv\Scripts\python.exe -X utf8 scripts\download_dependency_sources.py
.\.build-venv\Scripts\python.exe -X utf8 scripts\smoke_exe.py release\FaridaSongBrowser-0.0.23-windows-x64.exe
```

产物在 `release/`：单文件 EXE、ZIP、公开目录与链接清单、依赖源码包及 SHA-256 校验值。
EXE 包含 Python 运行时、界面、Frida 精灵图、公开目录和许可证；用户无需安装 Python。
每个发行版本的对应源码保存在同名 Git 标签中，依赖源码包附上游地址及校验信息。

构建只使用已提交的 `data/`，不会读取个人数据库。需要更新公开目录时，先运行：

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\export_public_catalog.py
```

检查并提交 `data/` 后再打包。详见[目录说明](../data/README.md)。
本地数据库、账号会话、构建环境和发行文件都由 `.gitignore` 排除。

## 排查接口问题

单独运行实时诊断会访问哔哩哔哩，结果保存在 `.local/live-diagnostics.json`；遇到访问限制会停止。
离线测试通过不代表接口在当前网络下可用。

```powershell
.\.venv\Scripts\python.exe -X utf8 scripts\diagnose.py --uid 210887872 --bvid BV1br4y1R7BP
```

[v0.0.5 验证记录](release-0.0.5-verification.md) · [v0.0.4 验证记录](release-0.0.4-verification.md) · [v0.0.2 验证记录](release-0.0.2-verification.md)
