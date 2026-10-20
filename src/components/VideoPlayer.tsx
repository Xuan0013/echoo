import React, { useRef, useEffect, useState } from 'react';
import YouTube from 'react-youtube';
import { EmbedPlayerController } from '../utils/embedPlayerController';

interface VideoPlayerProps {
  src: string;
  onTimeUpdate: (currentTime: number) => void;
  onLoadedMetadata: (duration: number) => void;
  videoRef: React.RefObject<HTMLVideoElement>;
  isPreview?: boolean;
  placeholderColor?: string;
  embedUrl?: string; // Embed播放器URL
  platform?: 'youtube' | 'local'; // 视频平台类型
  embedControllerRef?: React.RefObject<EmbedPlayerController | null>; // Embed播放器控制器引用
  videoId?: string; // 视频ID（用于YouTube）
  onYouTubeReady?: (event: any) => void; // YouTube 播放器准备就绪回调
  onYouTubeStateChange?: (event: any) => void; // YouTube 播放状态变化回调
}

// 格式化时间：将秒数转换为 MM:SS 或 HH:MM:SS 格式
const formatTime = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ 
  src, 
  onTimeUpdate, 
  onLoadedMetadata,
  videoRef,
  isPreview = false,
  placeholderColor = '#c1e8ff',
  embedUrl,
  platform = 'local',
  embedControllerRef,
  videoId,
  onYouTubeReady,
  onYouTubeStateChange
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [isAudioFile, setIsAudioFile] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const time = videoRef.current.currentTime;
      setCurrentTime(time);
      onTimeUpdate(time);
    }
  };

  const handleMetadata = () => {
    if (videoRef.current) {
      const dur = videoRef.current.duration;
      setDuration(dur);
      onLoadedMetadata(dur);
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (videoRef.current && duration) {
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = (e.clientX - rect.left) / rect.width;
      const newTime = pos * duration;
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const skipForward = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.min(videoRef.current.currentTime + 10, duration);
    }
  };

  const skipBackward = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(videoRef.current.currentTime - 10, 0);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      setVolume(newVolume);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      if (volume > 0) {
        videoRef.current.volume = 0;
        setVolume(0);
      } else {
        videoRef.current.volume = 1;
        setVolume(1);
      }
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    
    if (!isFullscreen) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  const showControlsTemporarily = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (!isPlaying) return; // 如果暂停，保持显示控制栏
      setShowControls(false);
    }, 3000);
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      const video = videoRef.current;
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
  }, [videoRef]);

  useEffect(() => {
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, []);

  const progressPercentage = duration ? (currentTime / duration) * 100 : 0;

  // 检测是否是音频文件
  useEffect(() => {
    if (src && !embedUrl && platform === 'local') {
      const audioExtensions = ['.mp3', '.m4a', '.wav', '.ogg', '.aac', '.flac', '.webm'];
      const isAudio = audioExtensions.some(ext => src.toLowerCase().includes(ext));
      setIsAudioFile(isAudio);
    } else {
      setIsAudioFile(false);
    }
  }, [src, embedUrl, platform]);

  // 在预览模式下，如果没有视频源，设置默认时长以便控制栏正常工作
  useEffect(() => {
    if (isPreview && !src && videoRef.current) {
      // 设置一个默认时长，让控制栏可以正常工作
      setDuration(60); // 假设60秒
    }
  }, [isPreview, src]);

  // 如果是音频文件或预览模式，使用灰框白底样式
  const usePreviewStyle = (isPreview && !src) || isAudioFile;
  // Embed 播放器使用无框但有大圆角的样式
  const isEmbedPlayer = Boolean(embedUrl && platform === 'youtube');

  return (
    <div 
      ref={containerRef}
      className={`relative w-full aspect-video bg-black overflow-hidden group ${
        usePreviewStyle 
          ? 'border border-slate-200 shadow-inner rounded-2xl' 
          : isEmbedPlayer 
          ? 'rounded-2xl' 
          : 'rounded-2xl shadow-lg'
      }`}
      style={usePreviewStyle ? { backgroundColor: '#ffffff' } : {}}
      onMouseMove={showControlsTemporarily}
      onMouseLeave={() => {
        if (isPlaying) {
          setShowControls(false);
        }
      }}
    >
      {isPreview && !src ? (
        // 预览模式占位符
        <div 
          className="w-full h-full flex items-center justify-center"
          style={{ backgroundColor: '#ffffff' }}
          onClick={togglePlay}
        />
      ) : embedUrl && platform === 'youtube' && videoId ? (
        // YouTube Embed 播放器（react-youtube）
        <YouTube
          videoId={videoId}
          opts={{
            width: '100%',
            height: '100%',
            playerVars: {
              autoplay: 0,
              controls: 1,
              modestbranding: 1,
              rel: 0,
              enablejsapi: 1,
            },
          }}
          className="w-full h-full"
          onReady={onYouTubeReady}
          onStateChange={onYouTubeStateChange}
        />
      ) : (
        // 本地视频播放器
        <video
          ref={videoRef}
          src={src}
          className="w-full h-full object-contain"
          playsInline
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleMetadata}
          onClick={togglePlay}
        />
      )}

      {/* 控制栏 - 仅在本地视频时显示 */}
      {(!embedUrl || platform === 'local') && (
      <div 
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent transition-opacity duration-300 ${
          showControls || !isPlaying ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 进度条 */}
        <div 
          className="h-1 bg-white/30 cursor-pointer hover:h-1.5 transition-all relative"
          onClick={handleSeek}
        >
          <div 
            className="h-full bg-red-600 transition-all relative"
            style={{ width: `${progressPercentage}%` }}
          />
          {/* 播放头指示器 */}
          <div 
            className="absolute top-1/2 transform -translate-y-1/2 w-3 h-3 bg-red-600 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ left: `calc(${progressPercentage}% - 6px)` }}
          />
        </div>

        {/* 控制按钮栏 */}
        <div className="flex items-center justify-between px-4 py-2">
          <div className="flex items-center gap-3">
            {/* 播放/暂停 */}
            <button
              onClick={togglePlay}
              className="text-white hover:text-gray-300 transition-colors flex items-center"
              aria-label={isPlaying ? 'Pause' : 'Play'}
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

            {/* 时间显示 */}
            <span className="text-white text-sm">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-3">
            {/* 音量控制 - YouTube风格，垂直滑块 */}
            <div 
              className="relative flex items-center"
              onMouseEnter={() => setShowVolumeSlider(true)}
              onMouseLeave={() => setShowVolumeSlider(false)}
            >
              <button
                onClick={toggleMute}
                className="text-white hover:text-gray-300 transition-colors flex items-center"
                aria-label="Volume"
              >
                {volume === 0 ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                )}
              </button>
              
              {/* 音量滑块 - 垂直显示在按钮上方，使用绝对定位避免布局抖动 */}
              <div 
                className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 bg-black/80 rounded px-2 py-3 transition-opacity duration-200"
                style={{ 
                  opacity: showVolumeSlider ? 1 : 0, 
                  pointerEvents: showVolumeSlider ? 'auto' : 'none' 
                }}
              >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={handleVolumeChange}
                  className="w-20 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, #dc2626 0%, #dc2626 ${volume * 100}%, rgba(255,255,255,0.3) ${volume * 100}%, rgba(255,255,255,0.3) 100%)`
                  }}
                />
              </div>
            </div>

            {/* 全屏按钮 */}
            <button
              onClick={toggleFullscreen}
              className="text-white hover:text-gray-300 transition-colors flex items-center"
              aria-label="Fullscreen"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      )}
    </div>
  );
};