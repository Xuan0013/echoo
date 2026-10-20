import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Subtitle } from '../types';

interface SubtitleListProps {
  subtitles: Subtitle[];
  currentTime: number;
  onSubtitleClick: (startTime: number) => void;
  isLoading: boolean;
  isTranslating?: boolean;
  // 来自 PracticePage 的控制参数（用于“上一句/下一句”+ 显示模式）
  scrollToSubtitleId?: number | null;
  displayMode?: 'original' | 'bilingual' | 'translation';
  // A-B 点（可选：仅用于未来在卡片上做标记，这里先透传不影响 UI）
  pointA?: number | null;
  pointB?: number | null;
  // 用于字幕蒙版测量：让外部能拿到滚动容器 ref
  containerRefExternal?: React.RefObject<HTMLDivElement>;
}

export type SubtitleListHandle = {
  startRecording: (id: number) => Promise<void>;
  stopRecording: () => Promise<void>;
  getRecordingId: () => number | null;
};

export const SubtitleList = forwardRef<SubtitleListHandle, SubtitleListProps>(function SubtitleList({
  subtitles,
  currentTime,
  onSubtitleClick,
  isLoading,
  isTranslating = false,
  scrollToSubtitleId = null,
  displayMode = 'bilingual',
  pointA = null,
  pointB = null,
  containerRefExternal,
}, ref) {
  const activeRef = useRef<HTMLDivElement>(null);
  const scrollTargetRef = useRef<HTMLDivElement>(null);
  const containerInternalRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [likedIds, setLikedIds] = useState<Set<number>>(() => new Set());

  // Per-subtitle recordings (in-memory only; cleared on unmount)
  const [recordings, setRecordings] = useState<Record<number, { blob: Blob; url: string }>>({});
  const recordingsRef = useRef<Record<number, { blob: Blob; url: string }>>({});
  const [recordingId, setRecordingId] = useState<number | null>(null);
  const recordingIdRef = useRef<number | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<BlobPart[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    recordingIdRef.current = recordingId;
  }, [recordingId]);

  const formatTimeShort = (seconds: number) => {
    const s = Math.max(0, seconds || 0);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const copyText = async (text: string) => {
    const t = (text || '').trim();
    if (!t) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(t);
        return;
      }
    } catch {
      // fallthrough
    }
    try {
      const el = document.createElement('textarea');
      el.value = t;
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      el.style.top = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    } catch {
      // ignore
    }
  };

  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const cleanupRecorder = () => {
    try {
      mediaRecorderRef.current = null;
    } catch {}
    try {
      const s = mediaStreamRef.current;
      if (s) s.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    } catch {}
    recorderChunksRef.current = [];
    recordingIdRef.current = null;
    setRecordingId(null);
  };

  const stopCurrentRecording = () =>
    new Promise<void>((resolve) => {
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== 'inactive') {
        const prevOnStop = rec.onstop;
        rec.onstop = (ev) => {
          try {
            if (typeof prevOnStop === 'function') prevOnStop.call(rec, ev);
          } finally {
            resolve();
          }
        };
        try {
          rec.stop();
        } catch {
          cleanupRecorder();
          resolve();
        }
      } else {
        cleanupRecorder();
        resolve();
      }
    });

  const startRecording = async (id: number) => {
    // Only allow one recording at a time；切换句子时先保存上一句
    const activeId = recordingIdRef.current;
    if (activeId !== null && activeId !== id) {
      await stopCurrentRecording();
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive' && recordingIdRef.current === id) {
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('当前浏览器不支持录音');
      return;
    }
    try {
      // 再次长按同一句：先清掉旧录音，松手后会写入新的（覆盖）
      setRecordings((prev) => {
        const old = prev[id];
        if (!old) return prev;
        if (old.url) URL.revokeObjectURL(old.url);
        const next = { ...prev };
        delete next[id];
        return next;
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorderChunksRef.current = [];
      recordingIdRef.current = id;
      setRecordingId(id);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recorderChunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        const chunks = recorderChunksRef.current;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        setRecordings((prev) => {
          const old = prev[id];
          if (old?.url) URL.revokeObjectURL(old.url);
          return { ...prev, [id]: { blob, url } };
        });
        cleanupRecorder();
      };

      recorder.start();
    } catch (e: any) {
      cleanupRecorder();
      alert(e?.message || '录音失败，请检查麦克风权限');
    }
  };

  useImperativeHandle(ref, () => ({
    startRecording,
    stopRecording: stopCurrentRecording,
    getRecordingId: () => recordingIdRef.current,
  }));

  const playRecording = (id: number) => {
    const entry = recordings[id];
    if (!entry) return;
    try {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    } catch {}
    const audio = new Audio(entry.url);
    audioRef.current = audio;
    setPlayingId(id);
    audio.onended = () => {
      if (audioRef.current === audio) audioRef.current = null;
      setPlayingId((prev) => (prev === id ? null : prev));
    };
    audio.play().catch(() => setPlayingId(null));
  };

  const deleteRecording = (id: number) => {
    try {
      if (playingId === id && audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
        setPlayingId(null);
      }
    } catch {}
    setRecordings((prev) => {
      const next = { ...prev };
      const old = next[id];
      if (old?.url) URL.revokeObjectURL(old.url);
      delete next[id];
      return next;
    });
  };

  // keep latest recordings for unmount cleanup
  useEffect(() => {
    recordingsRef.current = recordings;
  }, [recordings]);

  // Cleanup on unmount: stop recording + revoke all URLs + stop audio
  useEffect(() => {
    return () => {
      try {
        stopCurrentRecording();
      } catch {}
      try {
        if (audioRef.current) audioRef.current.pause();
      } catch {}
      try {
        (Object.values(recordingsRef.current) as Array<{ url: string }>).forEach((r) => {
          if (r?.url) URL.revokeObjectURL(r.url);
        });
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeId = useMemo(() => {
    const active = subtitles.find((sub) => currentTime >= sub.startTime && currentTime < sub.endTime);
    return active ? active.id : -1;
  }, [subtitles, currentTime]);

  // 滚动时让「上一句」贴顶，当前句落在视口第二位，避免只剩新句、上一句被顶走
  const scrollToSecondRowIfNeeded = (el: HTMLElement) => {
    const container = containerInternalRef.current;
    if (!container) return;
    const paddingTop = 8;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    const fullyVisible =
      elRect.top >= containerRect.top + paddingTop &&
      elRect.bottom <= containerRect.bottom;

    if (fullyVisible) return;

    let prev = el.previousElementSibling;
    while (prev instanceof HTMLElement && getComputedStyle(prev).position === 'absolute') {
      prev = prev.previousElementSibling;
    }
    const anchor = prev instanceof HTMLElement ? prev : el;
    const anchorRect = anchor.getBoundingClientRect();
    const delta = anchorRect.top - containerRect.top - paddingTop;
    const nextTop = Math.max(0, Math.min(container.scrollTop + delta, container.scrollHeight - container.clientHeight));
    container.scrollTo({ top: nextTop, behavior: 'smooth' });
  };

  // Auto-scroll: only when active subtitle changes, and only when it's not fully visible.
  useEffect(() => {
    if (activeRef.current) {
      scrollToSecondRowIfNeeded(activeRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // 外部触发滚动（用于“上一句/下一句”）
  useEffect(() => {
    if (!scrollToSubtitleId) return;
    if (scrollTargetRef.current) {
      scrollToSecondRowIfNeeded(scrollTargetRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToSubtitleId]);

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 space-y-3">
        <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin"></div>
        <p className="text-slate-700 text-sm font-fengyu">处理中…</p>
      </div>
    );
  }

  if (subtitles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-slate-400 font-fengyu">
        <p>暂无字幕</p>
      </div>
    );
  }

  return (
    <div
      ref={(node) => {
        (containerInternalRef as any).current = node;
        if (containerRefExternal) (containerRefExternal as any).current = node;
      }}
      className="h-full overflow-y-auto custom-scrollbar p-3 space-y-2 relative"
    >
      {isTranslating && (
        <div className="absolute inset-0 bg-white/60 z-10 flex items-center justify-center backdrop-blur-sm">
           <div className="flex flex-col items-center bg-white p-4 rounded-xl shadow-lg">
             <div className="w-6 h-6 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin mb-2"></div>
             <span className="text-sm font-medium text-slate-700 font-fengyu">翻译中…</span>
           </div>
        </div>
      )}

      {subtitles.map((sub) => {
        const isActive = sub.id === activeId;
        const isScrollTarget = scrollToSubtitleId != null && sub.id === scrollToSubtitleId;
        const showOriginal = displayMode === 'original' || displayMode === 'bilingual';
        const showTranslation = displayMode === 'translation' || displayMode === 'bilingual';
        const inAbRange = pointA != null && pointB != null && sub.startTime >= pointA && sub.startTime < pointB;
        const isA = pointA != null && Math.abs(sub.startTime - pointA) < 0.35;
        // pointB 存的是“终点字幕的 endTime”，所以要用 sub.endTime 匹配
        const isB = pointB != null && Math.abs(sub.endTime - pointB) < 0.35;
        const canCopy = (showOriginal && Boolean(sub.text)) || (showTranslation && Boolean(sub.translation));
        const isLiked = likedIds.has(sub.id);
        const hasRecording = Boolean(recordings[sub.id]);
        const isRecording = recordingId === sub.id;
        const isPlaying = playingId === sub.id;
        return (
          <div
            key={sub.id}
            ref={isScrollTarget ? scrollTargetRef : isActive ? activeRef : null}
            onClick={() => onSubtitleClick(sub.startTime)}
            className={[
              // card size + smaller radius (用户要求减小圆角)
              // 纵向更紧凑：略微减小 padding 与间距
              'rounded-xl cursor-pointer transition-all duration-150 border px-3 py-2 relative',
              isActive
                ? 'bg-[#FFFBE5] border-[#E38134] shadow-sm'
                : 'bg-white border-slate-200 hover:bg-slate-50 hover:border-slate-300',
              !isActive && inAbRange ? 'bg-[#FFFBE5]/40 border-[#E38134]/50' : '',
            ].join(' ')}
          >
            {/* A/B 点标记：右上角纯橙色圆圈 + 白色字母 */}
            {(isA || isB) && (
              <div className="absolute -top-2 -right-2 flex items-center gap-1">
                {/* 贴在圆角处：略微超出卡片边框，让圆圈“压住”右上角圆角 */}
                {isA && (
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white shadow-sm"
                    style={{ backgroundColor: '#E38134' }}
                  >
                    A
                  </div>
                )}
                {isB && (
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold text-white shadow-sm"
                    style={{ backgroundColor: '#E38134' }}
                  >
                    B
                  </div>
                )}
              </div>
            )}

            {showOriginal && (
              <div className="leading-relaxed text-slate-800 font-fengyu" style={{ fontSize: '16px' }}>
                {sub.text}
              </div>
            )}

            {showTranslation && (
              <div className="mt-0.5 text-[14px] leading-relaxed text-slate-600 font-fengyu">
                {sub.translation ? sub.translation : '（暂无译文）'}
              </div>
            )}

            {/* 底部工具栏：左下角 icon 一排；时间戳放右下角 */}
            <div className="mt-1.5 flex items-end justify-between">
              <div className="flex items-center gap-2">
                {/* 复制 */}
                <button
                  onClick={async (e) => {
                    stop(e);
                    if (!canCopy) return;
                    const payload =
                      displayMode === 'bilingual'
                        ? `${sub.text || ''}\n${sub.translation || ''}`.trim()
                        : displayMode === 'translation'
                        ? `${sub.translation || ''}`.trim()
                        : `${sub.text || ''}`.trim();
                    await copyText(payload);
                    setCopiedId(sub.id);
                    window.setTimeout(() => setCopiedId((prev) => (prev === sub.id ? null : prev)), 900);
                  }}
                  className="p-1 rounded-md hover:bg-white/60 border border-transparent hover:border-slate-200 transition-colors"
                  title="复制"
                  aria-label="复制"
                  disabled={!canCopy}
                  style={{ opacity: canCopy ? 1 : 0.35 }}
                >
                  {/* copy: two stacked docs + a few lines (simple) */}
                  <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {/* back doc (top-right) */}
                    <rect x="8" y="4" width="11" height="14" rx="2" strokeWidth={2} opacity="0.65" />
                    {/* front doc (bottom-left, overlapping back) */}
                    <rect x="4" y="8" width="11" height="14" rx="2" strokeWidth={2} fill="white" />
                    {/* text lines on front */}
                    <path strokeLinecap="round" strokeWidth={2} d="M7 12h5.5" />
                    <path strokeLinecap="round" strokeWidth={2} d="M7 15h6.5" />
                    <path strokeLinecap="round" strokeWidth={2} d="M7 18h4.5" />
                  </svg>
                </button>

                {/* 喜欢 */}
                <button
                  onClick={(e) => {
                    stop(e);
                    setLikedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(sub.id)) next.delete(sub.id);
                      else next.add(sub.id);
                      return next;
                    });
                  }}
                  className="p-1 rounded-md hover:bg-white/60 border border-transparent hover:border-slate-200 transition-colors"
                  title="喜欢"
                  aria-label="喜欢"
                >
                  <svg
                    className={`w-4 h-4 ${isLiked ? 'text-[#E38134]' : 'text-slate-600'}`}
                    fill={isLiked ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                    />
                  </svg>
                </button>

                {/* 录音：录音中 -> stop；已录音 -> play + delete；未录音 -> mic */}
                {!hasRecording && (
                  <button
                    onClick={(e) => {
                      stop(e);
                      startRecording(sub.id);
                    }}
                    className="p-1 rounded-md hover:bg-white/60 border border-transparent hover:border-slate-200 transition-colors"
                    title="开始录音"
                    aria-label="开始录音"
                    style={{ opacity: recordingId !== null && recordingId !== sub.id ? 0.4 : 1 }}
                    disabled={recordingId !== null && recordingId !== sub.id}
                  >
                    <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zm5 11a5 5 0 01-10 0m5 9v-3m-4 3h8" />
                    </svg>
                  </button>
                )}

                {isRecording && (
                  <button
                    onClick={(e) => {
                      stop(e);
                      stopCurrentRecording();
                    }}
                    className="p-1 rounded-md hover:bg-white/60 border border-transparent hover:border-slate-200 transition-colors"
                    title="停止录音"
                    aria-label="停止录音"
                  >
                    <svg className="w-4 h-4 text-[#E38134]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9h6v6H9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v16H4z" opacity="0.25" />
                    </svg>
                  </button>
                )}

                {hasRecording && !isRecording && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={(e) => {
                        stop(e);
                        playRecording(sub.id);
                      }}
                      className="p-1 rounded-md hover:bg-white/60 border border-transparent hover:border-slate-200 transition-colors"
                      title={isPlaying ? '播放中' : '播放录音'}
                      aria-label="播放录音"
                    >
                      <svg className={`w-4 h-4 ${isPlaying ? 'text-[#E38134]' : 'text-slate-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5v14l11-7z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        stop(e);
                        deleteRecording(sub.id);
                      }}
                      className="p-1 rounded-md hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors"
                      title="删除录音"
                      aria-label="删除录音"
                    >
                      <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7h6m2 0H7m3-3h4a1 1 0 011 1v2H9V5a1 1 0 011-1z" />
                      </svg>
                    </button>
                  </div>
                )}

                {copiedId === sub.id && (
                  <span className="text-[11px] font-fengyu text-[#E38134]">已复制</span>
                )}
              </div>

              <div className="text-[11px] font-mono opacity-80 text-slate-500 whitespace-nowrap">
                {formatTimeShort(sub.startTime)}-{formatTimeShort(sub.endTime)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});