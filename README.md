# WNACG 批量下载器

Tampermonkey 用户脚本，为 WNACG 多镜像站点提供批量下载功能。

## 功能

- **书架页** — 勾选相册批量下载，支持全选/反选，可包含所有分页
- **相册页** — 一键下载当前相册
- **系列作品识别** — 进入相册页时，若标题含“话/卷/Vol”等系列特征，自动在下方展示同系列条目
- **画廊页**（首页/分类/排行/搜索） — 选择模式批量勾选下载
- **移动端适配** — 底部悬浮工具栏、长按进入选择模式、触控友好

## 支持站点

`wnacg.com` · `wnacg.ru` · `wn01.cfd` · `wn01.shop` · `wn07.ru`

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击下方一键安装按钮
3. 如未自动唤起安装，可手动将 `wnacg_batch_downloader.user.js` 内容粘贴到 Tampermonkey 新建脚本中

[![Install Script](https://img.shields.io/badge/Tampermonkey-一键安装脚本-2ea44f?style=for-the-badge)](https://raw.githubusercontent.com/shaw465/wnacg_downloader/master/wnacg_batch_downloader.user.js)

## License

MIT
