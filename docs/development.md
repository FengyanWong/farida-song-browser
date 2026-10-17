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
源码方式保留终端输出；Windows EXE 在后台运行，可从页面账号菜单或登录界面选择「退出应用」。

应用只监听 `127.0.0.1`，默认端口为 8765；端口被占用时自动选择并记住其他端口。
可用 `--port` 指定端口，`--data-dir` 指定独立数据目录，`--no-browser` 不打开浏览器，
`--no-startup-scan` 暂停该次启动的自动采集。后者仍要求验证登录。

配置示例见 [`config.example.env`](../config.example.env)，该文件不会自动加载。
数据目录默认为 Windows 的 `%LOCALAPPDATA%\FaridaSongBrowser`，或其他系统的
`$XDG_DATA_HOME/farida-song-browser`（未设置时为 `~/.local/share/farida-song-browser`）。
EXE 的诊断输出保存在数据目录下的 `launcher.log`。备份前先退出应用，再复制整个数据目录。

## 构建 Windows EXE

使用 Windows x64、Python 3.12。运行时依赖锁定在 `requirements-lock.txt`，构建依赖锁定在 `requirements-build.txt`。

```powershell
py -3.12 -m venv .build-venv
.\.build-venv\Scripts\python.exe -m pip install -r requirements-build.txt
.\.build-venv\Scripts\python.exe -X utf8 scripts\build_windows.py
.\.build-venv\Scripts\python.exe -X utf8 scripts\download_dependency_sources.py
.\.build-venv\Scripts\python.exe -X utf8 scripts\smoke_exe.py release\FaridaSongBrowser-0.0.2-windows-x64.exe
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

[v0.0.2 验证记录](release-0.0.2-verification.md)
