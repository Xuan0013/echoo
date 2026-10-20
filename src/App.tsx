import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { HelpModal } from './components/HelpModal';
import { UploadPage } from './pages/UploadPage';
import { PracticePage } from './pages/PracticePage';
import { HistoryPage } from './pages/HistoryPage';
import { Subtitle, ProcessStatus } from './types';
import { translateSubtitles } from './services/translateService';
import {
  generateSubtitlesWithWhisper,
  generateSubtitlesWithWhisperFromLocalKey,
  generateSubtitlesWithWhisperFromCache,
} from './services/whisperService';
import { downloadVideoFromUrl, getVideoFileUrl, checkCacheStatus, getTranslationCache, saveTranslationToCache } from './services/videoService';
import { downloadVideoMp4FromUrl } from './services/videoService';
import { parseVideoUrl, ParsedVideoUrl } from './utils/videoUrlParser';
import {
  computeLocalVideoKey,
  uploadLocalVideoToServer,
  getLocalVideoPlaybackUrl,
  checkLocalVideoExists,
} from './services/localVideo';
import { HistoryItem, upsertHistory, fetchYouTubeTitle } from './services/historyStore';
import { getApiUrl } from './services/config';

type Page = 'upload' | 'practice' | 'preview' | 'history';

const PREVIEW_YOUTUBE_URL = 'https://www.youtube.com/watch?v=bo47JoSxl1s';

const getYouTubeVideoId = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.replace('/', '') || null;
    return u.searchParams.get('v');
  } catch {
    return null;
  }
};

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<Page>('upload');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [embedInfo, setEmbedInfo] = useState<ParsedVideoUrl | null>(null);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [status, setStatus] = useState<ProcessStatus>(ProcessStatus.IDLE);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [localVideoKey, setLocalVideoKey] = useState<string | null>(null);
  const [localVideoMeta, setLocalVideoMeta] = useState<{ name: string; type: string; size: number; lastModified: number } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [processProgress, setProcessProgress] = useState<{ label: string; percent: number } | null>(null);

  const updateProgress = (label: string, percent: number) => {
    setProcessProgress({ label, percent: Math.max(0, Math.min(100, Math.round(percent))) });
  };

  // Cleanup object URL on unmount or src change
  useEffect(() => {
    return () => {
      if (videoSrc) {
        URL.revokeObjectURL(videoSrc);
      }
    };
  }, [videoSrc]);

  const saveYouTubeHistory = async (videoId: string, url: string, subs: Subtitle[]) => {
    if (!videoId || !subs.length) return;
    try {
      const title = await fetchYouTubeTitle(url);
      await upsertHistory({
        id: videoId,
        kind: 'youtube',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: title || undefined,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        subtitles: subs,
      });
    } catch (e) {
      console.warn('[History] save youtube failed:', e);
    }
  };

  const saveLocalHistory = async (
    key: string,
    meta: { name: string; type: string; size: number; lastModified: number } | null,
    subs: Subtitle[]
  ) => {
    if (!key || !subs.length) return;
    try {
      await upsertHistory({
        id: key,
        kind: 'local',
        url: `local://${key}`,
        title: meta?.name || '本地视频',
        localMeta: meta || undefined,
        subtitles: subs,
      });
    } catch (e) {
      console.warn('[History] save local failed:', e);
    }
  };

  const handleFileSelect = async (file: File) => {
    setEmbedInfo(null);
    setLocalVideoKey(null);
    setLocalVideoMeta(null);
    setVideoSrc(null);
    setSubtitles([]);
    setErrorMsg(null);
    setStatus(ProcessStatus.PROCESSING);
    updateProgress('准备上传…', 5);

    let key: string | null = null;
    let meta: { name: string; type: string; size: number; lastModified: number } | null = null;

    try {
      // 1) 落盘到项目 local_videos/（本机持久化，不依赖浏览器存储）
      updateProgress('上传视频到本机…', 15);
      key = await computeLocalVideoKey(file);
      const uploaded = await uploadLocalVideoToServer(file, key);
      key = uploaded.localKey;
      meta = {
        name: uploaded.meta.name,
        type: uploaded.meta.type,
        size: uploaded.meta.size,
        lastModified: uploaded.meta.lastModified,
      };
      setLocalVideoKey(key);
      setLocalVideoMeta(meta);
      setVideoSrc(uploaded.url);

      // 2) 直接对落盘文件做 Whisper 转录（避免二次上传）
      updateProgress('Whisper 转录中（可能较慢）…', 40);
      const generatedSubtitles = await generateSubtitlesWithWhisperFromLocalKey(key);
      let finalSubtitles = generatedSubtitles;

      try {
        updateProgress('翻译字幕…', 70);
        const translatedSubtitles = await translateSubtitles(
          generatedSubtitles,
          'Chinese (Simplified)',
          (done, total) => {
            const ratio = total > 0 ? done / total : 1;
            updateProgress(`翻译字幕（${done}/${total}）…`, 70 + ratio * 25);
          }
        );
        finalSubtitles = translatedSubtitles;
        setSubtitles(translatedSubtitles);
      } catch (err: any) {
        console.error('Auto-translation failed, using original subtitles:', err);
        setSubtitles(generatedSubtitles);
      }

      updateProgress('写入历史记录…', 97);
      await saveLocalHistory(key, meta, finalSubtitles);

      updateProgress('完成', 100);
      setStatus(ProcessStatus.COMPLETED);
      setProcessProgress(null);
      setCurrentPage('practice');
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || 'Failed to generate subtitles.');
      setStatus(ProcessStatus.ERROR);
      setProcessProgress(null);
    }
  };

  const handlePreviewClick = async () => {
    setErrorMsg(null);
    setStatus(ProcessStatus.PROCESSING);
    setCurrentPage('preview');
    setEmbedInfo(null);
    setVideoSrc(null);
    setSubtitles([]);
    setLocalVideoKey(null);
    setLocalVideoMeta(null);
    updateProgress('加载预览…', 10);

    try {
      const cacheStatus = await checkCacheStatus(PREVIEW_YOUTUBE_URL);
      const parsed = parseVideoUrl(PREVIEW_YOUTUBE_URL);
      const videoId = cacheStatus.videoId || parsed?.videoId;
      if (!videoId) throw new Error('预览视频不可用');

      const videoResult = await downloadVideoMp4FromUrl(PREVIEW_YOUTUBE_URL);
      const videoUrl =
        videoResult.url
          ? videoResult.url.startsWith('http')
            ? videoResult.url
            : getApiUrl(videoResult.url)
          : getVideoFileUrl(`cache_${videoId}_video.mp4`);
      setVideoSrc(videoUrl);

      let originalSubtitles: Subtitle[] = [];
      const refreshedStatus = await checkCacheStatus(PREVIEW_YOUTUBE_URL);
      if (refreshedStatus.cached && refreshedStatus.status?.subtitles) {
        const subtitlesResponse = await fetch(getVideoFileUrl(`cache_${videoId}_subtitles.json`));
        const subtitlesData = await subtitlesResponse.json();
        originalSubtitles = subtitlesData.subtitles || subtitlesData;
      } else {
        await downloadVideoFromUrl(PREVIEW_YOUTUBE_URL);
        originalSubtitles = await generateSubtitlesWithWhisperFromCache(videoId);
      }

      const cachedTranslation = await getTranslationCache(PREVIEW_YOUTUBE_URL, 'zh');
      if (cachedTranslation) {
        const mergedSubtitles: Subtitle[] = originalSubtitles.map((original, index) => {
          const cached = cachedTranslation[index];
          const cachedTranslationText =
            (cached as any)?.translation || (cached as any)?.text || '';
          return {
            ...original,
            translation: cachedTranslationText || original.translation || '',
          };
        });
        setSubtitles(mergedSubtitles);
      } else {
        updateProgress('翻译字幕…', 75);
        const translatedSubtitles = await translateSubtitles(
          originalSubtitles,
          'Chinese (Simplified)',
          (done, total) => {
            const ratio = total > 0 ? done / total : 1;
            updateProgress(`翻译字幕（${done}/${total}）…`, 75 + ratio * 20);
          }
        );
        setSubtitles(translatedSubtitles);
        await saveTranslationToCache(PREVIEW_YOUTUBE_URL, 'zh', translatedSubtitles);
      }

      updateProgress('完成', 100);
      setStatus(ProcessStatus.COMPLETED);
      setProcessProgress(null);
    } catch (err: any) {
      setErrorMsg(err?.message || '预览练习页加载失败');
      setStatus(ProcessStatus.ERROR);
      setProcessProgress(null);
    }
  };

  const handleUrlSubmit = async (url: string) => {
    setSubtitles([]);
    setErrorMsg(null);
    setStatus(ProcessStatus.PROCESSING);
    setEmbedInfo(null);
    setVideoSrc(null);
    setLocalVideoKey(null);
    setLocalVideoMeta(null);
    updateProgress('解析链接…', 5);

    try {
      const isYouTubeUrl = url.includes('youtube.com') || url.includes('youtu.be');
      if (!isYouTubeUrl) {
        throw new Error('仅支持Youtube视频链接');
      }

      const parsed = parseVideoUrl(url);
      if (!parsed || parsed.platform !== 'youtube') {
        throw new Error('仅支持Youtube视频链接');
      }

      setEmbedInfo({
        embedUrl: parsed.embedUrl,
        platform: parsed.platform,
        videoId: parsed.videoId,
      });
      setVideoSrc(parsed.embedUrl);

      updateProgress('检查缓存…', 12);
      const cacheStatus = await checkCacheStatus(url);
      let generatedSubtitles: Subtitle[] = [];
      let audioFilename = '';
      let videoId = cacheStatus.videoId || parsed.videoId || getYouTubeVideoId(url);

      if (cacheStatus.cached && cacheStatus.status?.subtitles) {
        audioFilename = `cache_${videoId}_audio.mp3`;
        updateProgress('读取缓存字幕…', 35);
        const subtitlesResponse = await fetch(getVideoFileUrl(`cache_${videoId}_subtitles.json`));
        const subtitlesData = await subtitlesResponse.json();
        const originalSubtitles: Subtitle[] = subtitlesData.subtitles || subtitlesData;

        const cachedTranslation = await getTranslationCache(url, 'zh');
        if (cachedTranslation) {
          const mergedSubtitles: Subtitle[] = originalSubtitles.map((original, index) => {
            const cached = cachedTranslation[index];
            const cachedTranslationText =
              (cached as any)?.translation || (cached as any)?.text || '';
            return {
              ...original,
              translation: cachedTranslationText || original.translation || '',
            };
          });
          setSubtitles(mergedSubtitles);
          if (videoId) await saveYouTubeHistory(videoId, url, mergedSubtitles);
          updateProgress('完成', 100);
          setStatus(ProcessStatus.COMPLETED);
          setProcessProgress(null);
          setCurrentPage('practice');
          return;
        }

        generatedSubtitles = originalSubtitles;
      } else {
        updateProgress('下载音频（yt-dlp）…', 25);
        const downloadResult = await downloadVideoFromUrl(url);
        if (!downloadResult.success || !downloadResult.filename) {
          throw new Error(downloadResult.error || 'Failed to download video');
        }
        audioFilename = downloadResult.filename;
        videoId = videoId || getYouTubeVideoId(url) || parsed?.videoId || null;

        updateProgress('Whisper 转录中（可能较慢）…', 45);
        if (videoId) {
          generatedSubtitles = await generateSubtitlesWithWhisperFromCache(videoId);
        } else {
          const audioFileUrl = downloadResult.url
            ? downloadResult.url.startsWith('http')
              ? downloadResult.url
              : getApiUrl(downloadResult.url)
            : getVideoFileUrl(audioFilename);

          const response = await fetch(audioFileUrl);
          if (!response.ok) {
            throw new Error('音频下载失败，请重试');
          }
          const blob = await response.blob();
          if (!blob || blob.size < 1024) {
            throw new Error('音频下载失败，请重试');
          }
          const ext = audioFilename.split('.').pop()?.toLowerCase();
          const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
          const file = new File([blob], audioFilename, { type: mimeType });
          generatedSubtitles = await generateSubtitlesWithWhisper(file);
        }
      }

      let finalSubtitles = generatedSubtitles;
      try {
        updateProgress('翻译字幕…', 70);
        const translatedSubtitles = await translateSubtitles(
          generatedSubtitles,
          'Chinese (Simplified)',
          (done, total) => {
            const ratio = total > 0 ? done / total : 1;
            updateProgress(`翻译字幕（${done}/${total}）…`, 70 + ratio * 25);
          }
        );
        finalSubtitles = translatedSubtitles;
        setSubtitles(translatedSubtitles);
        if (videoId) {
          await saveTranslationToCache(url, 'zh', translatedSubtitles);
        }
      } catch (err) {
        console.error('Auto-translation failed, using original subtitles:', err);
        setSubtitles(generatedSubtitles);
      }

      if (videoId) {
        updateProgress('写入历史记录…', 97);
        await saveYouTubeHistory(videoId, url, finalSubtitles);
      }

      updateProgress('完成', 100);
      setStatus(ProcessStatus.COMPLETED);
      setProcessProgress(null);
      setCurrentPage('practice');
    } catch (err: any) {
      console.error('URL processing error:', err);
      setErrorMsg(err.message || '处理视频链接失败');
      setStatus(ProcessStatus.ERROR);
      setProcessProgress(null);
    }
  };

  const handleBackToUpload = () => {
    setCurrentPage('upload');
    setVideoSrc(null);
    setEmbedInfo(null);
    setSubtitles([]);
    setProcessProgress(null);
    setStatus(ProcessStatus.IDLE);
    setErrorMsg(null);
    setLocalVideoKey(null);
    setLocalVideoMeta(null);
  };

  const handleOpenHistory = async (item: HistoryItem) => {
    setSubtitles([]);
    setErrorMsg(null);
    setStatus(ProcessStatus.PROCESSING);
    setEmbedInfo(null);
    setVideoSrc(null);
    setLocalVideoKey(null);
    setLocalVideoMeta(null);

    try {
      if (item.kind === 'local') {
        const exists = await checkLocalVideoExists(item.id);
        if (!exists) {
          throw new Error('本地视频文件不存在（可能已删除）。请重新上传一次该视频。');
        }
        setVideoSrc(getLocalVideoPlaybackUrl(item.id));
        setEmbedInfo(null);
        setSubtitles(item.subtitles || []);
        setLocalVideoKey(item.id);
        setLocalVideoMeta(item.localMeta || null);
        setStatus(ProcessStatus.COMPLETED);
        setCurrentPage('practice');
        return;
      }

      const url = item.url || `https://www.youtube.com/watch?v=${item.id}`;
      const parsed = parseVideoUrl(url);
      if (!parsed || parsed.platform !== 'youtube' || !parsed.videoId) {
        throw new Error('仅支持Youtube视频链接');
      }
      setEmbedInfo({ embedUrl: parsed.embedUrl, platform: 'youtube', videoId: parsed.videoId });
      setVideoSrc(parsed.embedUrl);
      setSubtitles(item.subtitles || []);
      setStatus(ProcessStatus.COMPLETED);
      setCurrentPage('practice');
    } catch (e: any) {
      setErrorMsg(e?.message || '打开历史记录失败');
      setStatus(ProcessStatus.ERROR);
      setCurrentPage('history');
    }
  };

  const handleLanguageChange = async (_lang: string) => {
    // 兼容接口：显示模式在 PracticePage 内处理
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: '#ffffff' }}>
      <HelpModal open={showHelp} onClose={() => setShowHelp(false)} initialSection="shortcuts" />
      <Header
        onHomeClick={handleBackToUpload}
        onHistoryClick={() => setCurrentPage('history')}
        onPreviewClick={handlePreviewClick}
        onHelpClick={() => setShowHelp(true)}
      />

      <main
        className={`flex-1 max-w-7xl w-full mx-auto px-2 sm:px-3 lg:px-4 pb-4 flex justify-center ${
          currentPage === 'history' ? 'pt-2 items-start' : 'pt-4 items-center'
        }`}
      >
        {currentPage === 'upload' && (
          <UploadPage
            onFileSelect={handleFileSelect}
            onUrlSubmit={handleUrlSubmit}
            status={status}
            errorMsg={errorMsg}
            processProgress={processProgress}
          />
        )}

        {currentPage === 'history' && (
          <HistoryPage onOpen={handleOpenHistory} onBackHome={handleBackToUpload} />
        )}

        {(currentPage === 'practice' || currentPage === 'preview') && (
          <div className="w-full -mx-2 sm:-mx-3 lg:-mx-4">
            <PracticePage
              videoSrc={videoSrc}
              embedInfo={embedInfo}
              subtitles={subtitles}
              status={status}
              errorMsg={errorMsg}
              onBack={handleBackToUpload}
              onLanguageChange={handleLanguageChange}
              isPreview={currentPage === 'preview'}
              localVideoKey={localVideoKey}
              localVideoMeta={localVideoMeta}
              keyboardEnabled={!showHelp}
            />
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
