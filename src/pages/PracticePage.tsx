import React, { useState, useRef, useEffect } from 'react';
import { VideoPlayer } from '../components/VideoPlayer';
import { SubtitleList, SubtitleListHandle } from '../components/SubtitleList';
import { FreeMaskOverlay } from '../components/FreeMaskOverlay';
import { Subtitle, ProcessStatus } from '../types';
import { EmbedPlayerController } from '../utils/embedPlayerController';
import { getHistoryItem, setHistoryStarred } from '../services/historyStore';

// 显示模式选项
const DISPLAY_MODES = [
  { code: 'original', label: '原文' },
  { code: 'bilingual', label: '双语' },
  { code: 'translation', label: '译文' },
];

interface PracticePageProps {
  videoSrc: string | null;
  embedInfo?: { embedUrl: string; platform: 'youtube' | 'local'; videoId?: string } | null;
  subtitles: Subtitle[];
  status: ProcessStatus;
  errorMsg: string | null;
  onBack: () => void;
  onLanguageChange?: (lang: string) => Promise<void>;
  isPreview?: boolean;
  localVideoKey?: string | null;
  localVideoMeta?: { name: string; type: string; size: number; lastModified: number } | null;
  /** 帮助弹窗打开时关闭练习页快捷键，避免冲突 */
  keyboardEnabled?: boolean;
}


const SUBTITLE_TIME_TOLERANCE = 0.2; // 秒级容忍度，用于避免时间跳变导致的漏判

// 格式化时间：将秒数转换为 M:SS 或 MM:SS 格式
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const PracticePage: React.FC<PracticePageProps> = ({
  videoSrc,
  embedInfo,
  subtitles,
  status,
  errorMsg,
  onBack,
  onLanguageChange,
  isPreview = false,
  localVideoKey = null,
  localVideoMeta = null,
  keyboardEnabled = true,
}) => {
  // Debug logs are noisy during polling/looping. Enable only when needed:
  // localStorage.setItem('echoo_debug', '1')
  // localStorage.removeItem('echoo_debug')
  const DEBUG_LOGS = (import.meta as any)?.env?.DEV && localStorage.getItem('echoo_debug') === '1';
  const dlog = (...args: any[]) => {
    if (DEBUG_LOGS) console.log(...args);
  };
  const dwarn = (...args: any[]) => {
    if (DEBUG_LOGS) console.warn(...args);
  };

  const [currentTime, setCurrentTime] = useState<number>(0);
  const [displayMode, setDisplayMode] = useState<string>('original'); // 默认原文模式
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [isVideoLoop, setIsVideoLoop] = useState<boolean>(false);
  const [videoDuration, setVideoDuration] = useState<number>(0);
  const [pointA, setPointA] = useState<number | null>(null);
  const [pointB, setPointB] = useState<number | null>(null);
  const [abPointState, setAbPointState] = useState<'A' | 'B' | 'cancel'>('A');
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState<boolean>(false);
  const [sentenceLoopCount, setSentenceLoopCount] = useState<number>(0); // 0=不循环, -1=无限循环, 其他=循环次数
  const [showLoopMenu, setShowLoopMenu] = useState<boolean>(false);
  const [currentSubtitleLoopCount, setCurrentSubtitleLoopCount] = useState<number>(0); // 当前字幕已循环次数
  const [currentLoopingSubtitleId, setCurrentLoopingSubtitleId] = useState<number | null>(null); // 当前正在循环的字幕ID
  const [scrollToSubtitleId, setScrollToSubtitleId] = useState<number | null>(null); // 外部触发的滚动目标（用于"上一句"/"下一句"按钮）
  const isManualSeekRef = useRef<boolean>(false); // 标记是否是用户手动跳转
  const isSeekingRef = useRef<boolean>(false); // 标记是否正在跳转（避免跳转时的时间抖动导致字幕闪烁）
  const lastSeekTimeRef = useRef<number>(0); // 记录上次跳转的时间，用于防抖
  const lastLoopTriggerTimeRef = useRef<number>(0); // 记录上次循环触发的时间，防止重复触发
  const videoRef = useRef<HTMLVideoElement>(null);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const loopMenuRef = useRef<HTMLDivElement>(null);
  const embedControllerRef = useRef<EmbedPlayerController | null>(null);
  const youtubePlayerRef = useRef<any>(null); // react-youtube 的 player 对象
  // 注意：YouTube 的时间轮询统一在下方 useEffect 中处理，避免重复 setInterval 造成刷屏与性能问题
  const [isEmbedMode, setIsEmbedMode] = useState<boolean>(false);
  const [showFreeMask, setShowFreeMask] = useState<boolean>(false);
  const [showSubtitleMask, setShowSubtitleMask] = useState<boolean>(false);
  const [isStarred, setIsStarred] = useState<boolean>(false);
  const [isStarBusy, setIsStarBusy] = useState<boolean>(false);
  const videoOverlayContainerRef = useRef<HTMLDivElement>(null);
  const subtitleScrollContainerRef = useRef<HTMLDivElement>(null);
  const subtitlePanelContentRef = useRef<HTMLDivElement>(null);
  const subtitleListRef = useRef<SubtitleListHandle>(null);
  const yHeldRef = useRef(false);
  const yRolloverBusyRef = useRef(false);
  const [subtitleMaskRect, setSubtitleMaskRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!showSubtitleMask) return;

    const measure = () => {
      const target = subtitleScrollContainerRef.current;
      const parent = subtitlePanelContentRef.current;
      if (!target || !parent) return;
      const targetRect = target.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      setSubtitleMaskRect({
        left: targetRect.left - parentRect.left,
        top: targetRect.top - parentRect.top,
        width: targetRect.width,
        height: targetRect.height,
      });
    };

    measure();

    const ro = new ResizeObserver(() => measure());
    if (subtitlePanelContentRef.current) ro.observe(subtitlePanelContentRef.current);
    if (subtitleScrollContainerRef.current) ro.observe(subtitleScrollContainerRef.current);
    window.addEventListener('resize', measure);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [showSubtitleMask]);

  // 初始化 Embed 播放器控制器
  useEffect(() => {
    if (embedInfo && embedInfo.platform !== 'local' && embedInfo.videoId) {
      setIsEmbedMode(true);
      // YouTube 使用 react-youtube，不需要自定义控制器
      embedControllerRef.current = null;
    } else {
      setIsEmbedMode(false);
      embedControllerRef.current = null;
      youtubePlayerRef.current = null;
    }
  }, [embedInfo]);

  // 标星状态：对应历史记录里的 starred
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const historyId =
          embedInfo?.platform === 'youtube' && embedInfo.videoId
            ? embedInfo.videoId
            : localVideoKey || null;
        if (!historyId) {
          if (!cancelled) setIsStarred(false);
          return;
        }
        const item = await getHistoryItem(historyId);
        if (!cancelled) setIsStarred(Boolean(item?.starred));
      } catch {
        if (!cancelled) setIsStarred(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [embedInfo?.platform, embedInfo?.videoId, localVideoKey]);

  // YouTube 播放器准备就绪回调
  const handleYouTubeReady = (event: any) => {
    youtubePlayerRef.current = event.target;
    setIsEmbedMode(true);
  };

  // YouTube 播放状态变化回调
  const handleYouTubeStateChange = (event: any) => {
    // event.data: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 3 (buffering), 5 (cued)
    const playing = event.data === 1;
    setIsPlaying(playing);

    // 如果开启视频循环，YouTube结束后自动重播
    if (event.data === 0 && isVideoLoop && youtubePlayerRef.current) {
      // 如果单句循环启用，重置单句循环的内部状态，但保留 sentenceLoopCount
      if (sentenceLoopCount !== 0) {
        console.log('[Video Loop] YouTube video ended with single sentence loop active, resetting loop state');
        setCurrentLoopingSubtitleId(null);
        setCurrentSubtitleLoopCount(0);
      }
      try {
        youtubePlayerRef.current.seekTo(0, true);
        youtubePlayerRef.current.playVideo();
      } catch (err) {
        console.error('YouTube loop restart failed:', err);
      }
    }
  };

  // 定期更新 embed 播放器的当前时间
  // 注意：本地视频的 currentTime 通过 VideoPlayer 的 onTimeUpdate 回调更新
  // 
  // 关键差异说明：
  // 1. 本地播放器：使用浏览器原生 timeupdate 事件，触发频率高（每秒 10-60 次），同步且准确
  // 2. Embed 播放器：需要轮询 API，频率受限（250ms = 每秒 4 次），可能有延迟
  // 
  // 优化方案：
  // - 减少轮询间隔到 100ms（每秒 10 次），接近本地播放器的更新频率
  // - 添加错误处理和重试机制
  // - 确保播放器准备就绪后再开始轮询
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    
    if (isEmbedMode && embedInfo?.platform === 'youtube') {
      // YouTube 使用 react-youtube，直接更新
      // 使用 100ms 间隔，接近本地播放器的更新频率
      // 添加重试机制，等待播放器准备就绪
      let retryCount = 0;
      const maxRetries = 50; // 最多重试 5 秒（50 * 100ms）
      
      const startPolling = () => {
        if (cancelled) return;
        if (youtubePlayerRef.current) {
          interval = setInterval(() => {
            if (youtubePlayerRef.current) {
              try {
                const time = youtubePlayerRef.current.getCurrentTime();
                if (typeof time === 'number' && !isNaN(time) && time >= 0) {
                  setCurrentTime(time);
                }
              } catch (error) {
                // 静默处理错误，避免控制台噪音
                // YouTube API 可能在播放器未准备好时抛出错误
              }
            }
          }, 100); // 从 250ms 减少到 100ms，提高更新频率
        } else if (retryCount < maxRetries) {
          // 如果播放器还没准备好，重试
          retryCount++;
          retryTimer = setTimeout(startPolling, 100);
        } else {
          dwarn('[PracticePage] YouTube player not ready after retries');
        }
      };
      
      startPolling();
    }
    // 本地视频模式：currentTime 通过 VideoPlayer 的 onTimeUpdate prop 更新
    // 浏览器原生 timeupdate 事件触发频率高（每秒 10-60 次），无需轮询
    
    return () => {
      cancelled = true;
      if (interval) {
        clearInterval(interval);
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [isEmbedMode, embedInfo?.platform]);

  // 处理视频循环播放
  useEffect(() => {
    if (isEmbedMode) {
      // Embed 播放器的循环需要特殊处理
      // YouTube 的循环功能有限，这里暂时跳过
      return;
    }
    if (videoRef.current) {
      videoRef.current.loop = isVideoLoop;
    }
  }, [isVideoLoop, isEmbedMode]);

  // 本地/下载视频：在时间更新时检测结束并重播
  // 优先级：单句循环 > A-B点循环 > 视频循环
  useEffect(() => {
    // 如果A-B点循环启用，不启用视频循环
    if (pointA !== null && pointB !== null) {
      return;
    }
    
    if (!isEmbedMode && isVideoLoop && videoRef.current && videoDuration > 0) {
      // 预留一个很小的误差（100ms），保证在结束前触发
      if (currentTime >= videoDuration - 0.1) {
        // 如果单句循环启用，重置单句循环的内部状态，但保留 sentenceLoopCount
        if (sentenceLoopCount !== 0) {
      dlog('[Video Loop] Video ended with single sentence loop active, resetting loop state');
          setCurrentLoopingSubtitleId(null);
          setCurrentSubtitleLoopCount(0);
        }
        videoRef.current.currentTime = 0;
        videoRef.current.play();
      }
    }
  }, [currentTime, isVideoLoop, isEmbedMode, videoDuration, sentenceLoopCount, pointA, pointB]);

  // 监听视频播放状态
  useEffect(() => {
    if (isEmbedMode) {
      // Embed 播放器的播放状态需要定期检查
      const interval = setInterval(async () => {
        if (embedControllerRef.current) {
          try {
            const playing = await embedControllerRef.current.isPlaying();
            // 只有当状态确实改变时才更新，避免不必要的重渲染
            setIsPlaying(prev => {
              if (prev !== playing) {
                dlog(`[PracticePage] Play state changed: ${prev} -> ${playing}`);
                return playing;
              }
              return prev;
            });
          } catch (error) {
            // 静默处理错误
          }
        }
      }, 500);

      return () => clearInterval(interval);
    } else {
      const video = videoRef.current;
      if (!video) return;

      const handlePlay = () => setIsPlaying(true);
      const handlePause = () => setIsPlaying(false);
      const handleEnded = () => setIsPlaying(false);

      video.addEventListener('play', handlePlay);
      video.addEventListener('pause', handlePause);
      video.addEventListener('ended', handleEnded);

      return () => {
        video.removeEventListener('play', handlePlay);
        video.removeEventListener('pause', handlePause);
        video.removeEventListener('ended', handleEnded);
      };
    }
  }, [isEmbedMode, embedInfo?.platform]);

  // 设置视频播放速度
  useEffect(() => {
    if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
      youtubePlayerRef.current.setPlaybackRate(playbackRate);
    } else if (isEmbedMode && embedControllerRef.current) {
      embedControllerRef.current.setPlaybackRate(playbackRate);
    } else if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, isEmbedMode, embedInfo?.platform]);

  // 点击外部关闭倍速菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (speedMenuRef.current && !speedMenuRef.current.contains(event.target as Node)) {
        setShowSpeedMenu(false);
      }
    };

    if (showSpeedMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSpeedMenu]);

  // 点击外部关闭循环菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (loopMenuRef.current && !loopMenuRef.current.contains(event.target as Node)) {
        setShowLoopMenu(false);
      }
    };

    if (showLoopMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showLoopMenu]);


  // 处理A-B点循环播放
  // 优先级：单句循环 + A-B点循环（兼容模式）> 单独A-B点循环 > 视频循环
  useEffect(() => {
    if (!pointA || !pointB || pointA >= pointB) {
      return; // 如果 A-B 点未设置或无效，不启用循环
    }
    
    // 如果单句循环启用，A-B点循环由单句循环逻辑统一处理（在单句循环完成后检查是否超过B点）
    // 这里只处理没有单句循环时的A-B点循环
    if (sentenceLoopCount !== 0) {
      return;
    }

    if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
      // YouTube 播放器的 A-B 循环
      const interval = setInterval(() => {
        if (youtubePlayerRef.current) {
          try {
            const playerState = youtubePlayerRef.current.getPlayerState();
            // 只有在播放状态（1）且不在跳转中时才循环
            if (playerState === 1 && !isSeekingRef.current) { // YT.PlayerState.PLAYING
              const currentTime = youtubePlayerRef.current.getCurrentTime();
              if (currentTime >= pointB) {
                safeSeekTo(pointA, `A-B loop: YouTube`);
              }
            }
          } catch (error) {
            console.error('Failed to handle A-B loop in YouTube player:', error);
          }
        }
      }, 50); // 更频繁的检查
      return () => clearInterval(interval);
    } else if (isEmbedMode && embedControllerRef.current) {
      // Embed 播放器的 A-B 循环（via embedControllerRef）
      const interval = setInterval(async () => {
        try {
          if (!isSeekingRef.current) {
            const currentTime = await embedControllerRef.current!.getCurrentTime();
            if (currentTime >= pointB) {
              safeSeekTo(pointA, `A-B loop: embed`);
            }
          }
        } catch (error) {
          console.error('Failed to handle A-B loop in embed player:', error);
        }
      }, 50); // 更频繁的检查
      return () => clearInterval(interval);
    } else if (videoRef.current) {
      // 本地视频的 A-B 循环
      const video = videoRef.current;
      
      // 使用更频繁的检查来确保循环及时触发
      const checkInterval = setInterval(() => {
        if (video && !video.paused && !isSeekingRef.current && video.currentTime >= pointB) {
          safeSeekTo(pointA, `A-B loop: local video`);
        }
      }, 50); // 每50ms检查一次，确保及时响应

      // 同时使用 timeupdate 事件作为备用
      const handleTimeUpdate = () => {
        if (!isSeekingRef.current && video.currentTime >= pointB) {
          safeSeekTo(pointA, `A-B loop (timeupdate): local video`);
        }
      };

      video.addEventListener('timeupdate', handleTimeUpdate);
      
      return () => {
        clearInterval(checkInterval);
        video.removeEventListener('timeupdate', handleTimeUpdate);
      };
    }
  }, [pointA, pointB, isEmbedMode, embedInfo?.platform, sentenceLoopCount]);

  // 处理A/B点点击
  const handleABPointClick = async () => {
    // 获取当前高亮的字幕
    const currentSubtitle = getCurrentSubtitle();
    
    if (!currentSubtitle) {
      // 如果没有高亮字幕，提示用户
      dwarn('No active subtitle found. Please wait for a subtitle to be highlighted.');
      return;
    }

    if (abPointState === 'A') {
      // 点击A，标记当前高亮字幕的开始时间
      setPointA(currentSubtitle.startTime);
      setAbPointState('B');
      dlog(`A point set to subtitle start: ${currentSubtitle.startTime}s`);
    } else if (abPointState === 'B') {
      // 点击B，标记当前高亮字幕的结束时间
      const newPointB = currentSubtitle.endTime;
      
      // 检查是否已设置A点
      if (pointA === null) {
        alert('请先设置A点（起点），再设置B点（终点）');
        dwarn('B point cannot be set without A point. Please set A point first.');
        return;
      }
      
      // 确保 B 点大于 A 点
      if (newPointB <= pointA) {
        alert(`B点（${formatTime(newPointB)}）必须在A点（${formatTime(pointA)}）之后，请选择A点之后的字幕`);
        dwarn(`B point (${newPointB}s) must be greater than A point (${pointA}s). Current B point is before or equal to A point.`);
        return;
      }
      
      // B点有效，设置B点
      setPointB(newPointB);
      setAbPointState('cancel');
      dlog(`B point set to subtitle end: ${newPointB}s`);
      
      // 如果当前时间在B点之后，跳转到A点开始循环
      let currentTime = 0;
      if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
        try {
          currentTime = youtubePlayerRef.current.getCurrentTime();
          if (currentTime >= newPointB) {
            youtubePlayerRef.current.seekTo(pointA, true);
          }
        } catch (error) {
          console.error('Failed to seek to A point:', error);
        }
      } else if (isEmbedMode && embedControllerRef.current) {
        try {
          currentTime = await embedControllerRef.current.getCurrentTime();
          if (currentTime >= newPointB) {
            embedControllerRef.current.seekTo(pointA);
          }
        } catch (error) {
          console.error('Failed to seek to A point:', error);
        }
      } else if (videoRef.current) {
        currentTime = videoRef.current.currentTime;
        if (currentTime >= newPointB) {
          videoRef.current.currentTime = pointA;
        }
      }
    } else if (abPointState === 'cancel') {
      // 点击取消，清除A/B点
      setPointA(null);
      setPointB(null);
      setAbPointState('A');
      dlog('A-B points cleared');
    }
  };


  const handleDisplayModeChange = (mode: string) => {
    setDisplayMode(mode);
    // 不需要调用翻译，因为已经自动翻译成中文了，只需要切换显示模式
  };

  const handleSubtitleClick = (startTime: number) => {
    dlog('Subtitle clicked, startTime:', startTime, 'isEmbedMode:', isEmbedMode);

    // 标记这是用户手动跳转
    isManualSeekRef.current = true;
    
    // 点击时重置单句循环计数到当前句
    const clicked = subtitles.find(sub => sub.startTime === startTime);
    if (clicked) {
      setCurrentLoopingSubtitleId(clicked.id);
      setCurrentSubtitleLoopCount(0);
    }
    
    // 使用统一的跳转函数
    safeSeekTo(startTime, 'Subtitle click');
    
    // 改为：无论当前是否暂停，点击字幕卡片都会进入播放状态
    if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
      youtubePlayerRef.current.playVideo();
      setIsPlaying(true);
    } else if (isEmbedMode && embedControllerRef.current) {
      embedControllerRef.current.play();
      setIsPlaying(true);
    } else if (videoRef.current) {
      videoRef.current.play();
      setIsPlaying(true);
    }
    
    // 500ms 后清除手动跳转标记，允许单句循环继续工作
    setTimeout(() => {
      isManualSeekRef.current = false;
    }, 500);
  };

  // 获取当前激活的字幕（优化版本，避免频繁切换）
  const getCurrentSubtitle = () => {
    if (subtitles.length === 0) return undefined;
    
    // 如果正在跳转，使用上次的字幕，避免闪烁
    if (isSeekingRef.current && currentLoopingSubtitleId !== null) {
      const lastSub = subtitles.find(sub => sub.id === currentLoopingSubtitleId);
      if (lastSub) return lastSub;
    }

    // 首先查找当前时间所在的字幕（注意：startTime 不做“向前容忍”，避免在下一句开始前就被判到下一句）
    // 这对 A/B 点标记尤其重要：用户看到当前句时按下 B，不应该被打到下一句。
    const active = subtitles.find(
      (sub) =>
        currentTime >= sub.startTime &&
        currentTime <= sub.endTime + SUBTITLE_TIME_TOLERANCE
    );

    if (active) return active;

    // 如果没有找到匹配的字幕，查找最近的上一条字幕
    // 如果当前时间在上一条字幕结束时间和下一条字幕开始时间之间，保持上一条字幕高亮
    const previousSubtitle = [...subtitles]
      .reverse()
      .find(sub => sub.endTime <= currentTime + SUBTITLE_TIME_TOLERANCE);
    
    if (previousSubtitle) {
      // 查找下一条字幕（开始时间大于当前时间的第一个）
      const nextSubtitle = subtitles.find(sub => sub.startTime > currentTime);
      
      if (nextSubtitle) {
        // 如果当前时间在上一条结束和下一条开始之间，保持上一条高亮
        if (currentTime > previousSubtitle.endTime && currentTime < nextSubtitle.startTime) {
          return previousSubtitle;
        }
      } else {
        // 如果没有下一条字幕（已经是最后一条），且当前时间超过最后一条的结束时间
        // 仍然保持最后一条高亮
        if (currentTime > previousSubtitle.endTime) {
          return previousSubtitle;
        }
      }
    }

    // 如果已经略微超过最后一句的结束时间，也回落到最后一句，避免循环判定失效
    const last = subtitles[subtitles.length - 1];
    if (last && currentTime > last.endTime + SUBTITLE_TIME_TOLERANCE) {
      return last;
    }

    return undefined;
  };
  
  // 安全的跳转函数，统一处理所有跳转逻辑
  const safeSeekTo = (targetTime: number, reason: string) => {
    // 防抖：如果距离上次跳转时间太近（100ms内），忽略这次跳转
    const now = Date.now();
    if (now - lastSeekTimeRef.current < 100) {
      dlog(`Seek ignored (too frequent): ${reason} to ${targetTime.toFixed(2)}s`);
      return;
    }
    lastSeekTimeRef.current = now;
    
    // 标记正在跳转
    isSeekingRef.current = true;
    dlog(`Seeking: ${reason} to ${targetTime.toFixed(2)}s`);
    
    if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
      try {
        youtubePlayerRef.current.seekTo(targetTime, true);
      } catch (error) {
        console.error('Failed to seek YouTube:', error);
        isSeekingRef.current = false;
      }
    } else if (isEmbedMode && embedControllerRef.current) {
      embedControllerRef.current.seekTo(targetTime).catch((error) => {
        console.error('Failed to seek embed:', error);
        isSeekingRef.current = false;
      });
    } else if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
    }
    
    // 200ms 后清除跳转标记，允许字幕检测恢复正常
    setTimeout(() => {
      isSeekingRef.current = false;
    }, 200);
  };

  // 处理单句循环逻辑
  // 优先级：单句循环 > A-B点循环 > 视频循环
  useEffect(() => {
    // 如果单句循环未启用，清除状态
    if (sentenceLoopCount === 0 || subtitles.length === 0) {
      setCurrentLoopingSubtitleId(null);
      setCurrentSubtitleLoopCount(0);
      return;
    }

    // 如果用户正在手动跳转，暂时不处理单句循环
    if (isManualSeekRef.current) {
      return;
    }

    // 如果已经有正在循环的字幕，检查是否到达结束时间
    if (currentLoopingSubtitleId !== null) {
      const loopingSub = subtitles.find(sub => sub.id === currentLoopingSubtitleId);
      if (!loopingSub) {
        // 如果找不到对应的字幕，清除状态
        setCurrentLoopingSubtitleId(null);
        setCurrentSubtitleLoopCount(0);
        return;
      }

      // 检查是否到达字幕结束时间（留一点误差，避免时间精度问题）
      // 使用更严格的判断：必须超过结束时间，且不在跳转中
      const hasReachedEnd = currentTime >= loopingSub.endTime - 0.05 && !isSeekingRef.current;
      
      // 如果A-B点已设置，在单句循环过程中检查是否超过B点
      // 重要：只有在明显超过B点（超过1秒）时才跳转，否则允许完成当前循环
      // 这样可以确保最后一句能够完成所有循环次数
      if (pointA !== null && pointB !== null && !isSeekingRef.current && !hasReachedEnd) {
        // 如果当前时间明显超过B点（超过1秒），立即跳转
        // 否则允许完成当前字幕的循环
        if (currentTime > pointB + 1.0) {
          dlog(`[Single Loop + AB Loop] Current time ${currentTime.toFixed(2)}s significantly exceeded B point ${pointB.toFixed(2)}s (by ${(currentTime - pointB).toFixed(2)}s), looping back to A point`);
          safeSeekTo(pointA, `Single sentence loop + A-B loop: exceeded B point, looping back`);
          const firstSubAfterA = subtitles.find(sub => sub.startTime >= pointA);
          if (firstSubAfterA) {
            setCurrentLoopingSubtitleId(firstSubAfterA.id);
            setCurrentSubtitleLoopCount(0);
          }
          return;
        }
        // 如果只是略微超过B点（1秒内），继续播放到字幕结束，完成循环
      }
      
      if (hasReachedEnd) {
        // 防抖：如果距离上次触发时间太近（300ms内），忽略这次触发
        const now = Date.now();
        if (now - lastLoopTriggerTimeRef.current < 300) {
          return;
        }
        lastLoopTriggerTimeRef.current = now;
        
        const nextCount = currentSubtitleLoopCount + 1;
        dlog(`[Single Loop] Reached end. Current count: ${currentSubtitleLoopCount}, Next: ${nextCount}, Target: ${sentenceLoopCount}, Time: ${currentTime.toFixed(2)}s`);
        
        if (sentenceLoopCount === -1) {
          // 无限循环：跳回当前字幕开始
          dlog(`[Single Loop] Infinite loop: restarting subtitle ${loopingSub.id}`);
          safeSeekTo(loopingSub.startTime, `Single sentence loop (infinite): subtitle ${loopingSub.id}`);
          // 无限循环不需要更新计数
        } else if (nextCount < sentenceLoopCount) {
          // 继续循环：跳回当前字幕开始，增加计数
          // 注意：使用 < 而不是 <=，因为 currentSubtitleLoopCount 从 0 开始计数
          // 如果 sentenceLoopCount = 3，需要循环到 currentSubtitleLoopCount = 2（即 nextCount = 3 时完成）
          dlog(`[Single Loop] Continuing loop: subtitle ${loopingSub.id}, count ${nextCount}/${sentenceLoopCount}`);
          setCurrentSubtitleLoopCount(nextCount);
          safeSeekTo(loopingSub.startTime, `Single sentence loop: subtitle ${loopingSub.id}, count ${nextCount}/${sentenceLoopCount}`);
        } else {
          // 循环完成：移动到下一个字幕，重置状态
          // nextCount >= sentenceLoopCount 时，说明已经完成了指定次数的循环
          dlog(`[Single Loop] Loop completed: subtitle ${loopingSub.id} (played ${nextCount} times), moving to next`);
          setCurrentSubtitleLoopCount(0);
          setCurrentLoopingSubtitleId(null);
          
          // 在移动到下一句之前，检查当前时间是否超过B点
          if (pointA !== null && pointB !== null && currentTime >= pointB) {
            // 已经超过B点，跳回A点
            dlog(`[Single Loop + AB Loop] After completing loop, current time ${currentTime.toFixed(2)}s exceeded B point ${pointB.toFixed(2)}s, looping back to A point`);
            safeSeekTo(pointA, `Single sentence loop + A-B loop: looping back to A point`);
            const firstSubAfterA = subtitles.find(sub => sub.startTime >= pointA);
            if (firstSubAfterA) {
              setCurrentLoopingSubtitleId(firstSubAfterA.id);
            }
            return;
          }
          
          const currentIndex = subtitles.findIndex(sub => sub.id === loopingSub.id);
          if (currentIndex < subtitles.length - 1) {
            // 有下一句：检查下一句是否在A-B点范围内
            const nextSub = subtitles[currentIndex + 1];
            
            // 如果A-B点已设置，检查下一句是否在范围内
            if (pointA !== null && pointB !== null) {
              // 如果下一句的开始时间在B点之后或等于B点，跳回A点（A-B点循环）
              if (nextSub.startTime >= pointB) {
                dlog(`[Single Loop + AB Loop] Next subtitle ${nextSub.id} is at or beyond B point (${pointB.toFixed(2)}s), looping back to A point (${pointA.toFixed(2)}s)`);
                safeSeekTo(pointA, `Single sentence loop + A-B loop: looping back to A point`);
                // 找到A点之后的第一个字幕，设置为循环目标
                const firstSubAfterA = subtitles.find(sub => sub.startTime >= pointA);
                if (firstSubAfterA) {
                  setCurrentLoopingSubtitleId(firstSubAfterA.id);
                }
                return;
              }
              // 如果下一句的开始时间在A点之前，跳转到A点
              if (nextSub.startTime < pointA) {
                dlog(`[Single Loop + AB Loop] Next subtitle ${nextSub.id} is before A point (${pointA.toFixed(2)}s), seeking to A point`);
                safeSeekTo(pointA, `Single sentence loop + A-B loop: seeking to A point`);
                const firstSubAfterA = subtitles.find(sub => sub.startTime >= pointA);
                if (firstSubAfterA) {
                  setCurrentLoopingSubtitleId(firstSubAfterA.id);
                }
                return;
              }
            }
            
            // 正常情况：跳转到下一句开始
            safeSeekTo(nextSub.startTime, `Single sentence loop: moving to next subtitle ${nextSub.id}`);
            // 设置下一句为循环目标
            setCurrentLoopingSubtitleId(nextSub.id);
          } else {
            // 已是最后一句：循环完成后，检查A-B点循环
            if (pointA !== null && pointB !== null) {
              // 如果A-B点已设置，跳回A点继续循环
              dlog(`[Single Loop + AB Loop] Last subtitle completed, looping back to A point`);
              safeSeekTo(pointA, `Single sentence loop + A-B loop: looping back to A point`);
              const firstSubAfterA = subtitles.find(sub => sub.startTime >= pointA);
              if (firstSubAfterA) {
                setCurrentLoopingSubtitleId(firstSubAfterA.id);
              }
            } else {
              // 没有A-B点循环
              if (isVideoLoop) {
                // 如果开启了视频循环，重置单句循环状态，让它在视频重新开始时继续工作
                dlog(`[Single Loop] Last subtitle completed, video loop enabled, resetting loop state`);
                setCurrentLoopingSubtitleId(null);
                setCurrentSubtitleLoopCount(0);
              } else {
                // 没有视频循环，停止单句循环
                dlog(`[Single Loop] Last subtitle completed, stopping loop`);
                setSentenceLoopCount(0); // 自动关闭单句循环
              }
            }
          }
        }
      }
      return; // 如果正在循环某个字幕，只处理循环逻辑，不处理新字幕检测
    }

    // 如果没有正在循环的字幕，检测当前应该循环哪个字幕
    const currentSub = getCurrentSubtitle();
    if (currentSub) {
      // 如果A-B点已设置，确保当前字幕在A-B点范围内
      if (pointA !== null && pointB !== null) {
        // 如果当前字幕在A-B点范围内，开始循环
        if (currentSub.startTime >= pointA && currentSub.startTime < pointB) {
          setCurrentLoopingSubtitleId(currentSub.id);
          setCurrentSubtitleLoopCount(0);
          dlog(`[Single Loop + AB Loop] Starting loop for subtitle ${currentSub.id} within A-B range (${pointA.toFixed(2)}s - ${pointB.toFixed(2)}s)`);
        } else if (currentSub.startTime < pointA) {
          // 如果当前字幕在A点之前，跳转到A点
          dlog(`[Single Loop + AB Loop] Current subtitle ${currentSub.id} is before A point, seeking to A point`);
          safeSeekTo(pointA, `Single sentence loop + A-B loop: seeking to A point`);
          const firstSubAfterA = subtitles.find(sub => sub.startTime >= pointA);
          if (firstSubAfterA) {
            setCurrentLoopingSubtitleId(firstSubAfterA.id);
            setCurrentSubtitleLoopCount(0);
          }
        } else {
          // 如果当前字幕在B点之后，跳回A点
          dlog(`[Single Loop + AB Loop] Current subtitle ${currentSub.id} is beyond B point, looping back to A point`);
          safeSeekTo(pointA, `Single sentence loop + A-B loop: looping back to A point`);
          const firstSubAfterA = subtitles.find(sub => sub.startTime >= pointA);
          if (firstSubAfterA) {
            setCurrentLoopingSubtitleId(firstSubAfterA.id);
            setCurrentSubtitleLoopCount(0);
          }
        }
      } else {
        // 没有A-B点循环，正常开始循环
        setCurrentLoopingSubtitleId(currentSub.id);
        setCurrentSubtitleLoopCount(0);
        dlog(`[Single Loop] Starting loop for subtitle ${currentSub.id}`);
      }
    }
  }, [currentTime, sentenceLoopCount, currentLoopingSubtitleId, currentSubtitleLoopCount, isEmbedMode, subtitles, embedInfo?.platform, pointA, pointB]);

  // 跳转到上一句
  const handlePreviousSentence = () => {
    const wasPlaying =
      isEmbedMode
        ? (embedInfo?.platform === 'youtube' && youtubePlayerRef.current
          ? (() => {
              try {
                const state = youtubePlayerRef.current.getPlayerState?.();
                return state === 1 ? true : state === 2 ? false : isPlaying;
              } catch {
                return isPlaying;
              }
            })()
          : isPlaying)
        : (videoRef.current ? !videoRef.current.paused : isPlaying);

    // 标记这是用户手动跳转
    isManualSeekRef.current = true;
    
    if (subtitles.length === 0) return;
    
    const currentSub = getCurrentSubtitle();
    let targetSubtitle: Subtitle;
    
    if (!currentSub) {
      targetSubtitle = subtitles[0];
    } else {
      const currentIndex = subtitles.findIndex(sub => sub.id === currentSub.id);
      if (currentIndex > 0) {
        targetSubtitle = subtitles[currentIndex - 1];
      } else {
        targetSubtitle = subtitles[0];
      }
    }

    // 更新单句循环状态到目标字幕
    if (sentenceLoopCount !== 0) {
      setCurrentLoopingSubtitleId(targetSubtitle.id);
      setCurrentSubtitleLoopCount(0);
    }

    // 触发滚动到目标字幕
    setScrollToSubtitleId(targetSubtitle.id);

    // 使用统一的跳转函数
    safeSeekTo(targetSubtitle.startTime, 'Previous sentence');
    
    // 保留原本播放状态
    if (wasPlaying) {
      if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
        youtubePlayerRef.current.playVideo();
      } else if (isEmbedMode && embedControllerRef.current) {
        embedControllerRef.current.play();
      } else if (videoRef.current) {
        videoRef.current.play();
      }
    } else {
      if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
        setTimeout(() => {
          try {
            youtubePlayerRef.current?.pauseVideo?.();
          } catch {}
        }, 0);
      }
    }
    
    // 500ms 后清除手动跳转标记，允许单句循环继续工作
    setTimeout(() => {
      isManualSeekRef.current = false;
    }, 500);
  };

  // 跳转到下一句
  const handleNextSentence = () => {
    const wasPlaying =
      isEmbedMode
        ? (embedInfo?.platform === 'youtube' && youtubePlayerRef.current
          ? (() => {
              try {
                const state = youtubePlayerRef.current.getPlayerState?.();
                return state === 1 ? true : state === 2 ? false : isPlaying;
              } catch {
                return isPlaying;
              }
            })()
          : isPlaying)
        : (videoRef.current ? !videoRef.current.paused : isPlaying);

    // 标记这是用户手动跳转
    isManualSeekRef.current = true;
    
    if (subtitles.length === 0) return;
    
    const currentSub = getCurrentSubtitle();
    let targetSubtitle: Subtitle;
    
    if (!currentSub) {
      targetSubtitle = subtitles[0];
    } else {
      const currentIndex = subtitles.findIndex(sub => sub.id === currentSub.id);
      if (currentIndex < subtitles.length - 1) {
        targetSubtitle = subtitles[currentIndex + 1];
      } else {
        targetSubtitle = subtitles[subtitles.length - 1];
      }
    }

    // 更新单句循环状态到目标字幕
    if (sentenceLoopCount !== 0) {
      setCurrentLoopingSubtitleId(targetSubtitle.id);
      setCurrentSubtitleLoopCount(0);
    }

    // 触发滚动到目标字幕
    setScrollToSubtitleId(targetSubtitle.id);

    // 使用统一的跳转函数
    safeSeekTo(targetSubtitle.startTime, 'Next sentence');
    
    // 保留原本播放状态
    if (wasPlaying) {
      if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
        youtubePlayerRef.current.playVideo();
      } else if (isEmbedMode && embedControllerRef.current) {
        embedControllerRef.current.play();
      } else if (videoRef.current) {
        videoRef.current.play();
      }
    } else {
      if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
        setTimeout(() => {
          try {
            youtubePlayerRef.current?.pauseVideo?.();
          } catch {}
        }, 0);
      }
    }
    
    // 500ms 后清除手动跳转标记，允许单句循环继续工作
    setTimeout(() => {
      isManualSeekRef.current = false;
    }, 500);
  };

  // 播放/暂停切换
  const handlePlayPause = async () => {
    if (isEmbedMode && embedInfo?.platform === 'youtube' && youtubePlayerRef.current) {
      if (isPlaying) {
        youtubePlayerRef.current.pauseVideo();
        setIsPlaying(false);
      } else {
        youtubePlayerRef.current.playVideo();
        setIsPlaying(true);
      }
    } else if (isEmbedMode && embedControllerRef.current) {
      if (isPlaying) {
        embedControllerRef.current.pause();
        setIsPlaying(false);
      } else {
        embedControllerRef.current.play();
        setIsPlaying(true);
      }
    } else if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
        setIsPlaying(false);
      } else {
        videoRef.current.play();
        setIsPlaying(true);
      }
    }
  };

  const shortcutHandlersRef = useRef({
    handlePlayPause,
    handlePreviousSentence,
    handleNextSentence,
    getCurrentSubtitle,
  });
  shortcutHandlersRef.current = {
    handlePlayPause,
    handlePreviousSentence,
    handleNextSentence,
    getCurrentSubtitle,
  };

  // 练习页快捷键：←/→ 切句，空格播停，长按 Y 录音
  useEffect(() => {
    if (!keyboardEnabled || status === ProcessStatus.PROCESSING) return;

    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        void shortcutHandlersRef.current.handlePlayPause();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        shortcutHandlersRef.current.handlePreviousSentence();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        shortcutHandlersRef.current.handleNextSentence();
        return;
      }
      if ((e.key === 'y' || e.key === 'Y') && !e.repeat) {
        e.preventDefault();
        yHeldRef.current = true;
        const sub = shortcutHandlersRef.current.getCurrentSubtitle();
        if (sub) void subtitleListRef.current?.startRecording(sub.id);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'y' || e.key === 'Y') {
        yHeldRef.current = false;
        void subtitleListRef.current?.stopRecording();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (yHeldRef.current) {
        yHeldRef.current = false;
        void subtitleListRef.current?.stopRecording();
      }
    };
  }, [status, keyboardEnabled]);

  // 长按 Y 期间跨句：保存上一句录音，自动开始下一句
  const activeSubtitleIdForY = (() => {
    const sub = getCurrentSubtitle();
    return sub?.id ?? null;
  })();
  useEffect(() => {
    if (!yHeldRef.current || yRolloverBusyRef.current) return;
    if (activeSubtitleIdForY === null) return;
    const recordingId = subtitleListRef.current?.getRecordingId() ?? null;
    if (recordingId === null || recordingId === activeSubtitleIdForY) return;

    yRolloverBusyRef.current = true;
    const nextId = activeSubtitleIdForY;
    (async () => {
      try {
        await subtitleListRef.current?.stopRecording();
        if (yHeldRef.current) {
          await subtitleListRef.current?.startRecording(nextId);
        }
      } finally {
        yRolloverBusyRef.current = false;
      }
    })();
  }, [activeSubtitleIdForY]);

  // 倍速选项：0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x
  const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];

  // 选择倍速
  const handleSpeedSelect = (speed: number) => {
    setPlaybackRate(speed);
    setShowSpeedMenu(false);
  };

  // 循环选项
  const loopOptions = [
    { label: '不循环', value: 0 },
    { label: '循环2次', value: 2 },
    { label: '循环3次', value: 3 },
    { label: '循环5次', value: 5 },
    { label: '循环10次', value: 10 },
    { label: '无限循环', value: -1 },
  ];

  // 选择循环次数
  const handleLoopSelect = (count: number) => {
    setSentenceLoopCount(count);
    setShowLoopMenu(false);
    // 重置循环状态
    setCurrentLoopingSubtitleId(null);
    setCurrentSubtitleLoopCount(0);
  };

  return (
    <div className="w-full">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 h-[calc(100vh-80px)] px-2 sm:px-4 lg:px-6">
      {/* Left Column: Video Player */}
      <div className="lg:col-span-6 flex flex-col space-y-4">
        <div ref={videoOverlayContainerRef} className={`relative ${embedInfo?.platform ? "" : ""}`}>
          {videoSrc || isPreview ? (
            <VideoPlayer 
              src={videoSrc || ''}
              videoRef={videoRef}
              onTimeUpdate={(time) => {
                // 节流时间更新，避免过于频繁导致字幕闪烁
                // 如果正在跳转，暂时不更新，避免时间抖动
                if (!isSeekingRef.current) {
                  setCurrentTime(time);
                }
              }}
              onLoadedMetadata={(dur) => setVideoDuration(dur)}
              isPreview={isPreview && !videoSrc}
              placeholderColor="#c1e8ff"
              embedUrl={embedInfo?.embedUrl}
              platform={embedInfo?.platform || 'local'}
              embedControllerRef={embedControllerRef}
              videoId={embedInfo?.videoId}
              onYouTubeReady={handleYouTubeReady}
              onYouTubeStateChange={handleYouTubeStateChange}
            />
          ) : (
            <div className="w-full aspect-video bg-slate-100 rounded-md flex items-center justify-center">
              <p className="text-slate-400">暂无视频</p>
            </div>
          )}

          {showFreeMask && (
            <FreeMaskOverlay
              containerRef={videoOverlayContainerRef}
              onClose={() => setShowFreeMask(false)}
            />
          )}
        </div>

        {/* 视频控制栏 */}
        <div className="flex flex-col items-center gap-2 px-2 relative">
          {/* 控制按钮行 */}
          <div className="flex items-center justify-center gap-3">
          {/* 视频循环按钮 */}
          <div className="relative group flex flex-col items-center">
            <button
              onClick={() => setIsVideoLoop(!isVideoLoop)}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                isVideoLoop 
                  ? 'text-white' 
                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
              style={isVideoLoop ? { backgroundColor: '#ef9b59' } : {}}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            {/* 按钮文字标签 */}
            <span className="text-xs text-slate-600 mt-1">视频循环</span>
            {/* 悬停提示 */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
              视频结束后循环播放
              {/* 小三角箭头 */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-slate-800 transform rotate-45"></div>
              </div>
            </div>
          </div>

          {/* A点按钮 */}
          <div className="relative group flex flex-col items-center">
            <button
              onClick={handleABPointClick}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                abPointState === 'cancel'
                  ? 'bg-red-500 text-white'
                  : pointA !== null && abPointState === 'B'
                  ? 'text-white'
                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
              style={pointA !== null && abPointState === 'B' ? { backgroundColor: '#ef9b59' } : {}}
            >
              {abPointState === 'cancel' ? (
                // 取消图标（X）
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                // A或B字母
                <span className="text-sm font-bold">{abPointState}</span>
              )}
            </button>
            {/* 按钮文字标签 */}
            <span className="text-xs text-slate-600 mt-1">片段循环</span>
            {/* 悬停提示 */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
              {abPointState === 'A' && '标记起点'}
              {abPointState === 'B' && '标记终点'}
              {abPointState === 'cancel' && '取消A-B点循环'}
              {/* 小三角箭头 */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-slate-800 transform rotate-45"></div>
              </div>
            </div>
          </div>

          {/* 上一句按钮 */}
          <div className="relative group flex flex-col items-center">
            <button
              onClick={handlePreviousSentence}
              disabled={subtitles.length === 0}
              className="w-10 h-10 rounded-full flex items-center justify-center transition-all bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            {/* 按钮文字标签 */}
            <span className="text-xs text-slate-600 mt-1">上一句</span>
            {/* 悬停提示 */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
              跳转到上一句
              {/* 小三角箭头 */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-slate-800 transform rotate-45"></div>
              </div>
            </div>
          </div>

          {/* 播放/暂停按钮 */}
          <div className="relative group flex flex-col items-center">
            <button
              onClick={handlePlayPause}
              disabled={!videoSrc && !isPreview}
              className="w-10 h-10 rounded-full flex items-center justify-center transition-all text-white disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: '#ef9b59' }}
              onMouseEnter={(e) => {
                if (!e.currentTarget.disabled) {
                  e.currentTarget.style.backgroundColor = '#d8873f';
                }
              }}
              onMouseLeave={(e) => {
                if (!e.currentTarget.disabled) {
                  e.currentTarget.style.backgroundColor = '#ef9b59';
                }
              }}
            >
              {isPlaying ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            {/* 按钮文字标签 */}
            <span className="text-xs text-slate-600 mt-1">播放</span>
            {/* 悬停提示 */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
              {isPlaying ? '暂停' : '播放'}
              {/* 小三角箭头 */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-slate-800 transform rotate-45"></div>
              </div>
            </div>
          </div>

          {/* 下一句按钮 */}
          <div className="relative group flex flex-col items-center">
            <button
              onClick={handleNextSentence}
              disabled={subtitles.length === 0}
              className="w-10 h-10 rounded-full flex items-center justify-center transition-all bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            {/* 按钮文字标签 */}
            <span className="text-xs text-slate-600 mt-1">下一句</span>
            {/* 悬停提示 */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
              跳转到下一句
              {/* 小三角箭头 */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-slate-800 transform rotate-45"></div>
              </div>
            </div>
          </div>

          {/* 倍速按钮 */}
          <div className="relative group flex flex-col items-center" ref={speedMenuRef}>
            <button
              onClick={() => setShowSpeedMenu(!showSpeedMenu)}
              disabled={!videoSrc && !isPreview}
              className="w-10 h-10 rounded-full flex items-center justify-center transition-all bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="text-sm font-medium">{playbackRate}x</span>
            </button>
            {/* 按钮文字标签 */}
            <span className="text-xs text-slate-600 mt-1">倍速</span>
            {/* 悬停提示 */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
              调整播放倍速
              {/* 小三角箭头 */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-slate-800 transform rotate-45"></div>
              </div>
            </div>
            
            {/* 倍速选择浮窗 */}
            {showSpeedMenu && (
              <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 bg-white rounded-lg shadow-lg p-4 z-50 border border-slate-200 min-w-[280px]">
                <div className="grid grid-cols-3 gap-x-3 gap-y-2">
                  {speedOptions.map((speed) => (
                    <button
                      key={speed}
                      onClick={() => handleSpeedSelect(speed)}
                      className={`py-2 rounded text-sm font-medium transition-all ${
                        playbackRate === speed
                          ? 'text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                      style={playbackRate === speed ? { backgroundColor: '#ef9b59', paddingLeft: '4px', paddingRight: '4px' } : { paddingLeft: '4px', paddingRight: '4px' }}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 单句循环按钮 */}
          <div className="relative group flex flex-col items-center" ref={loopMenuRef}>
            <button
              onClick={() => setShowLoopMenu(!showLoopMenu)}
              disabled={subtitles.length === 0 && !isPreview}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                sentenceLoopCount > 0 || sentenceLoopCount === -1
                  ? 'text-white'
                  : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
              style={(sentenceLoopCount > 0 || sentenceLoopCount === -1) ? { backgroundColor: '#ef9b59' } : {}}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            {/* 按钮文字标签 */}
            <span className="text-xs text-slate-600 mt-1">单句循环</span>
            {/* 悬停提示 */}
            <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-800 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-none">
              单句循环设置
              {/* 小三角箭头 */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
                <div className="w-2 h-2 bg-slate-800 transform rotate-45"></div>
              </div>
            </div>
            
            {/* 循环选择浮窗 */}
            {showLoopMenu && (
              <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 bg-white rounded-lg shadow-lg p-4 z-50 border border-slate-200 min-w-[280px]">
                <div className="grid grid-cols-3 gap-x-3 gap-y-2">
                  {loopOptions.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleLoopSelect(option.value)}
                      className={`py-2 rounded text-sm font-medium transition-all text-center ${
                        sentenceLoopCount === option.value
                          ? 'text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                      style={sentenceLoopCount === option.value ? { backgroundColor: '#ef9b59', paddingLeft: '4px', paddingRight: '4px' } : { paddingLeft: '4px', paddingRight: '4px' }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          </div>
          
          {/* A-B点循环时间段显示 - 显示在按钮行下方，不影响按钮位置 */}
          {pointA !== null && pointB !== null && (
            <div className="mt-2 px-2 py-0.5 bg-slate-100 rounded text-xs text-slate-600 font-medium whitespace-nowrap">
              循环播放 {formatTime(pointA)}-{formatTime(pointB)}
            </div>
          )}
        </div>
        
        <div className="flex justify-between items-center px-2">
          <div>
            <button 
              onClick={onBack}
              className="text-sm text-slate-500 flex items-center gap-1 transition-colors"
              style={{ color: '#4a2c3a' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#ef9b59';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#4a2c3a';
              }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              {isPreview ? '返回首页' : '返回首页'}
            </button>
          </div>
        </div>

        {status === ProcessStatus.ERROR && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            <p className="font-bold">Error:</p>
            {errorMsg}
          </div>
        )}
      </div>

      {/* Right Column: Transcript / Subtitles */}
      <div className="lg:col-span-6 rounded-2xl border border-slate-200 overflow-hidden shadow-inner flex flex-col relative h-full" style={{ backgroundColor: '#ffffff' }}>
        <div className="bg-white py-3 px-4 border-b border-slate-200 flex items-center justify-between shadow-sm z-20 gap-2">
          <div className="flex items-center gap-2">
            {/* 五角星：标星历史（可在历史页筛选） */}
            <button
              onClick={async () => {
                if (isStarBusy || isPreview) return;
                const historyId =
                  embedInfo?.platform === 'youtube' && embedInfo.videoId
                    ? embedInfo.videoId
                    : localVideoKey || null;
                if (!historyId) return;
                setIsStarBusy(true);
                try {
                  const updated = await setHistoryStarred(historyId, !isStarred);
                  if (updated) setIsStarred(updated.starred);
                  else dwarn('历史记录尚不存在，请等处理完成后再标星');
                } catch (e: any) {
                  dwarn(e?.message || '标星失败');
                } finally {
                  setIsStarBusy(false);
                }
              }}
              className="p-1.5 hover:bg-slate-100 rounded-md transition-colors"
              title={isStarred ? '取消标星' : '标星'}
              disabled={
                isStarBusy ||
                isPreview ||
                !(Boolean((embedInfo?.platform === 'youtube' && embedInfo.videoId) || localVideoKey))
              }
            >
              <svg
                className={`w-4 h-4 transition-colors ${
                  isStarred ? 'text-yellow-500' : 'text-slate-600 hover:text-yellow-500'
                }`}
                fill={isStarred ? 'currentColor' : 'none'}
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </button>
            {/* 下载图标 */}
            <button
              onClick={() => {
                // TODO: 实现下载功能
                dlog('Download clicked');
              }}
              className="p-1.5 hover:bg-slate-100 rounded-md transition-colors -ml-1"
              title="下载字幕"
            >
              <svg className="w-4 h-4 text-slate-600 hover:text-slate-800 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>

            {/* 左侧空白区域：蒙版按钮 */}
            <div className="flex items-center gap-2 ml-2">
              <button
                onClick={() => setShowFreeMask((v) => !v)}
                className="px-3 py-1 rounded-full transition-all border text-xs font-fengyu whitespace-nowrap"
                style={showFreeMask ? { backgroundColor: '#FFFBE5', borderColor: '#E38134', color: '#E38134' } : { backgroundColor: '#ffffff', borderColor: '#d1d5db', color: '#000000' }}
              >
                自由蒙版
              </button>
              <button
                onClick={() => setShowSubtitleMask((v) => !v)}
                className="px-3 py-1 rounded-full transition-all border text-xs font-fengyu whitespace-nowrap"
                style={showSubtitleMask ? { backgroundColor: '#FFFBE5', borderColor: '#E38134', color: '#E38134' } : { backgroundColor: '#ffffff', borderColor: '#d1d5db', color: '#000000' }}
              >
                字幕蒙版
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* 滑动切换开关（配色对齐“自由蒙版”按钮风格） */}
            <div
              className="relative inline-flex rounded-full p-0.5 border"
              style={{
                pointerEvents: status === ProcessStatus.PROCESSING || subtitles.length === 0 ? 'none' : 'auto',
                opacity: status === ProcessStatus.PROCESSING || subtitles.length === 0 ? 0.5 : 1,
                backgroundColor: '#ffffff',
                borderColor: '#d1d5db',
              }}
            >
              {/* 滑动高亮块：奶油底色 */}
              <div
                className="absolute top-0.5 bottom-0.5 rounded-full transition-all duration-300 ease-in-out border"
                style={{
                  width: `calc(33.333% - 1px)`,
                  left:
                    displayMode === 'original'
                      ? '1px'
                      : displayMode === 'bilingual'
                      ? 'calc(33.333% + 0.5px)'
                      : 'calc(66.666% + 0px)',
                  backgroundColor: '#FFFBE5',
                  borderColor: '#E38134',
                }}
              />
              {/* 选项按钮 */}
              {DISPLAY_MODES.map((mode) => (
                <button
                  key={mode.code}
                  onClick={() => handleDisplayModeChange(mode.code)}
                  disabled={status === ProcessStatus.PROCESSING || subtitles.length === 0}
                  className="relative z-10 flex-1 px-3 py-1 text-xs rounded-full transition-colors duration-200 whitespace-nowrap font-fengyu"
                  style={
                    displayMode === mode.code
                      ? { color: '#E38134', fontWeight: 400 }
                      : { color: '#000000', fontWeight: 400 }
                  }
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        
        <div ref={subtitlePanelContentRef} className="flex-1 overflow-hidden relative">
          <SubtitleList
            ref={subtitleListRef}
            subtitles={subtitles}
            currentTime={currentTime}
            onSubtitleClick={handleSubtitleClick}
            isLoading={status === ProcessStatus.PROCESSING}
            isTranslating={isTranslating}
            scrollToSubtitleId={scrollToSubtitleId}
            displayMode={displayMode}
            pointA={pointA}
            pointB={pointB}
            containerRefExternal={subtitleScrollContainerRef}
          />

          {/* 字幕蒙版：固定尺寸、不可移动，覆盖所有字幕卡片 */}
          {showSubtitleMask && subtitleMaskRect && (
            <div className="absolute inset-0 z-30 pointer-events-auto">
              <div
                className="absolute rounded-2xl"
                style={{
                  left: subtitleMaskRect.left,
                  top: subtitleMaskRect.top,
                  width: subtitleMaskRect.width,
                  height: subtitleMaskRect.height,
                  background: 'rgba(255, 255, 255, 0.22)',
                  border: '1px solid rgba(255, 255, 255, 0.30)',
                  boxShadow: '0 10px 30px rgba(0,0,0,0.12)',
                  backdropFilter: 'blur(10px) saturate(120%)',
                  WebkitBackdropFilter: 'blur(10px) saturate(120%)',
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
  );
};

