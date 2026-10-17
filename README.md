# 法里达 · 歌切收藏

轻量的哔哩哔哩歌切收藏工具。中文深色界面，显示封面、标题、UP 主和上传时间；点击标题，在默认浏览器打开原视频。

**[下载 Windows 版 v0.0.2](https://github.com/FengyanWong/farida-song-browser/releases/download/v0.0.2/FaridaSongBrowser-0.0.2-windows-x64.exe)** · [全部下载与更新说明](https://github.com/FengyanWong/farida-song-browser/releases/latest)

## 开始使用

1. 双击 EXE，无需安装 Python。页面自动打开，应用在后台运行，不显示终端窗口。
2. 首次用哔哩哔哩手机 App 扫码登录。之后有效登录会自动使用，每次启动更新一次来源。
3. 搜索歌名、点击标题看原视频，或用星标收藏。退出时点击右上角账号菜单 → **退出应用**。

关闭浏览器标签页后，应用仍在后台运行；再次双击 EXE 可重新打开页面。

## 功能与来源

- **两个页面**：片段收藏、采集来源。支持搜索、筛选、收藏和 CSV 导出，只保存链接与信息，不下载音视频。
- **随附目录**：1,075 个视频、1,286 条片段（其中 1,037 条已收录），以及 1,077 个不同 BV 链接。[目录详情](data/README.md)
- **默认来源**：离落、CLANNADOR、阿见、稻草仁尔，以及同时带有「法里达」「直播切片」标签的视频。
- **歌单同步**：每次更新读取 [小法的歌单](https://fareeda.songlist.cc/)，感谢 **CLANNADOR** 整理。
- **Frida 小伙伴**：默认附带，支持 v1 / v2 精灵图，可隐藏或关闭动画。

目录和收藏保存在本机 `%LOCALAPPDATA%\FaridaSongBrowser`。升级保留已有数据；发行包不含个人登录信息、星标或备注。

## 更多

[使用说明](使用说明.txt) · [开发与打包](docs/development.md) · [第三方署名](THIRD_PARTY_NOTICES.md)

开源许可：[GNU GPL 3.0 only](LICENSE)。
