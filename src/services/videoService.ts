// 音频下载服务（从视频URL提取音频）
import { API_BASE_URL } from './config';

export interface VideoDownloadResponse {
  success: boolean;
  filename?: string;
  size?: number;
  url?: string;
  error?: string;
  message?: string;
}

export interface VideoFileDownloadResponse {
  success: boolean;
  filename?: string;
  size?: number;
  url?: string;
  isCached?: boolean;
  message?: string;
}

/**
 * 从URL下载音频（从视频中提取）
 * @param url YouTube 视频链接
 * @returns 下载的音频信息
 */
export const downloadVideoFromUrl = async (url: string): Promise<VideoDownloadResponse> => {
  try {
    // 首先检查后端服务是否可用
    const healthCheck = await checkBackendHealth();
    if (!healthCheck) {
      throw new Error('后端服务未运行，请确保后端服务已启动（npm run server）');
    }

    const response = await fetch(`${API_BASE_URL}/api/video/from-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    // 检查响应状态
    if (!response.ok) {
      let errorMessage = '下载失败';
      try {
        const data = await response.json();
        errorMessage = data.message || data.error || `服务器错误: ${response.status}`;
      } catch {
        errorMessage = `网络错误: ${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    
    if (!data.success) {
      throw new Error(data.message || data.error || '下载失败');
    }

    return data;
  } catch (error: any) {
    console.error('Audio download error:', error);
    // 如果是网络错误，提供更友好的提示
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      throw new Error('无法连接到后端服务，请确保后端服务已启动（npm run server）');
    }
    throw new Error(error.message || '下载音频失败，请检查：1) 后端服务是否运行 2) yt-dlp 和 ffmpeg 是否已安装 3) 视频链接是否有效');
  }
};

/**
 * 获取音频文件的完整URL
 * @param filename 文件名
 * @returns 完整的音频URL
 */
export const getVideoFileUrl = (filename: string): string => {
  return `${API_BASE_URL}/api/video/file/${filename}`;
};

/**
 * 下载并缓存 720p 视频（mp4）
 */
export const downloadVideoMp4FromUrl = async (url: string): Promise<VideoFileDownloadResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/video/video-from-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    let msg = `下载失败: ${response.status}`;
    try {
      const data = await response.json();
      msg = data.message || data.error || msg;
    } catch {}
    throw new Error(msg);
  }

  const data = await response.json();
  if (!data.success) {
    throw new Error(data.message || '视频下载失败');
  }
  return data;
};

/**
 * 检查缓存状态
 */
export const checkCacheStatus = async (url: string) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/cache/status?url=${encodeURIComponent(url)}`);
    if (!response.ok) return { cached: false };
    return await response.json();
  } catch (error) {
    console.error('Cache status check error:', error);
    return { cached: false };
  }
};

/**
 * 获取翻译缓存
 */
export const getTranslationCache = async (url: string, lang: string) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/cache/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, lang })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.success ? data.subtitles : null;
  } catch (error) {
    return null;
  }
};

/**
 * 保存翻译到缓存
 */
export const saveTranslationToCache = async (url: string, lang: string, subtitles: any[]) => {
  try {
    await fetch(`${API_BASE_URL}/api/cache/translation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, lang, subtitles })
    });
  } catch (error) {
    console.error('Failed to save translation to cache:', error);
  }
};

/**
 * 删除 YouTube 视频在服务器上的 cache/<videoId>/ 目录
 */
export const deleteVideoCache = async (url: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/cache`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.message || '删除缓存失败');
  }
};

/**
 * 检查后端服务是否可用
 */
export const checkBackendHealth = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
};

