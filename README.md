# Echoo

本地 Shadowing 练习工具：上传视频或粘贴 YouTube 链接，自动转录、翻译，并支持历史复用。

## 环境要求

- Node.js + npm
- [ffmpeg](https://ffmpeg.org/download.html)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- 本地 Whisper：`pip install openai-whisper`

### 安装 yt-dlp

```bash
# macOS
brew install yt-dlp

# Linux / Windows
pip install yt-dlp
```

### 安装 ffmpeg

```bash
# macOS
brew install ffmpeg

# Linux (Ubuntu/Debian)
sudo apt-get install ffmpeg
```

Windows 可从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载，或 `choco install ffmpeg`。

## 快速开始

```bash
npm install
npm run dev:all
```

也可分开启动：

```bash
npm run dev      # 前端 http://localhost:3000
npm run server   # 后端 http://localhost:3001
```

浏览器打开：http://localhost:3000

## 目录说明

| 路径 | 作用 |
|------|------|
| `src/` | 前端源码（页面、组件、服务） |
| `server/` | Express 后端 |
| `public/` | 静态资源 |
| `data/` | 运行时数据（缓存、本地视频等，不入库） |

## 功能概览

- 本地 Whisper 转录字幕
- 小牛翻译（后端代理）生成中文译文
- YouTube 链接练习 + 预览页
- 历史记录（本机元数据 + `data/local_videos/` 落盘）

## 故障排除

- **后端无法启动**：确认已安装 yt-dlp、ffmpeg，且 3001 端口空闲
- **音频/视频下载失败**：检查链接与网络；优先使用系统安装的 yt-dlp（`brew`/`pip`），并用终端启动后端
- **CORS**：确认后端在 `localhost:3001`，前端通过 Vite 代理访问 `/api`
