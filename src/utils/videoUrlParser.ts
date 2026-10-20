// 视频 URL 解析工具（仅 YouTube）

export interface ParsedVideoUrl {
  platform: 'youtube' | 'unknown';
  videoId: string;
  embedUrl: string;
  originalUrl: string;
}

/**
 * 解析 YouTube 视频链接
 */
const parseYouTubeUrl = (url: string): ParsedVideoUrl | null => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      const videoId = match[1];
      return {
        platform: 'youtube',
        videoId,
        embedUrl: `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${window.location.origin}`,
        originalUrl: url,
      };
    }
  }

  return null;
};

/**
 * 解析视频 URL，返回平台信息和 embed URL
 */
export const parseVideoUrl = (url: string): ParsedVideoUrl | null => {
  if (!url) return null;

  const youtubeResult = parseYouTubeUrl(url);
  if (youtubeResult) return youtubeResult;

  return {
    platform: 'unknown',
    videoId: '',
    embedUrl: url,
    originalUrl: url,
  };
};

/**
 * 检查 URL 是否是支持的视频平台
 */
export const isSupportedVideoPlatform = (url: string): boolean => {
  const parsed = parseVideoUrl(url);
  return parsed !== null && parsed.platform === 'youtube';
};
