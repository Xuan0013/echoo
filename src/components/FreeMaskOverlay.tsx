import React, { useEffect, useMemo, useRef, useState } from 'react';

type FreeMaskRect = {
  x: number; // px
  y: number; // px
  w: number; // px
  h: number; // px
};

type DragMode = 'move' | 'resize-br' | 'resize-tl' | null;

interface FreeMaskOverlayProps {
  /** A ref to the container we should stay within (typically the VideoPlayer wrapper) */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Initial rect; if omitted we'll compute a sensible default based on container size */
  initialRect?: Partial<FreeMaskRect>;
  onClose: () => void;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export const FreeMaskOverlay: React.FC<FreeMaskOverlayProps> = ({ containerRef, initialRect, onClose }) => {
  const [rect, setRect] = useState<FreeMaskRect>({ x: 24, y: 24, w: 260, h: 90 });
  const dragModeRef = useRef<DragMode>(null);
  const pointerStartRef = useRef<{ px: number; py: number; rect: FreeMaskRect } | null>(null);

  const minSize = useMemo(() => ({ w: 90, h: 60 }), []);
  const maskRadiusPx = 16; // 与播放器 rounded-2xl 视觉一致（≈16px）

  // Compute a default rect once container is measurable
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const bounds = el.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const defaultRect: FreeMaskRect = {
      // place near bottom where subtitles usually are
      x: Math.round(bounds.width * 0.18),
      y: Math.round(bounds.height * 0.72),
      w: Math.round(bounds.width * 0.64),
      h: Math.round(bounds.height * 0.18),
    };

    const merged: FreeMaskRect = {
      x: initialRect?.x ?? defaultRect.x,
      y: initialRect?.y ?? defaultRect.y,
      w: initialRect?.w ?? defaultRect.w,
      h: initialRect?.h ?? defaultRect.h,
    };

    setRect((prev) => {
      // only set if we're still at the hardcoded default (avoid overwriting user drag)
      if (prev.x === 24 && prev.y === 24) return merged;
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef.current]);

  const updateRect = (next: FreeMaskRect) => {
    const el = containerRef.current;
    if (!el) {
      setRect(next);
      return;
    }

    const bounds = el.getBoundingClientRect();
    // 先 clamp 尺寸，再用 clamped 尺寸计算可用的 x/y 范围（避免出现“反向扩展”的怪异边界情况）
    const w = clamp(next.w, minSize.w, bounds.width);
    const h = clamp(next.h, minSize.h, bounds.height);
    const maxX = Math.max(0, bounds.width - w);
    const maxY = Math.max(0, bounds.height - h);

    setRect({
      x: clamp(next.x, 0, maxX),
      y: clamp(next.y, 0, maxY),
      w,
      h,
    });
  };

  const begin = (e: React.PointerEvent, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    dragModeRef.current = mode;
    pointerStartRef.current = { px: e.clientX, py: e.clientY, rect };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const move = (e: React.PointerEvent) => {
    const start = pointerStartRef.current;
    const mode = dragModeRef.current;
    if (!start || !mode) return;

    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - start.px;
    const dy = e.clientY - start.py;

    if (mode === 'move') {
      updateRect({ ...start.rect, x: start.rect.x + dx, y: start.rect.y + dy });
      return;
    }

    if (mode === 'resize-br') {
      // resize from bottom-right
      updateRect({ ...start.rect, w: start.rect.w + dx, h: start.rect.h + dy });
      return;
    }

    // resize from top-left: 左上角为拖拽点，右下角保持为锚点（符合“往左上拉就朝左上延展”）
    updateRect({
      ...start.rect,
      x: start.rect.x + dx,
      y: start.rect.y + dy,
      w: start.rect.w - dx,
      h: start.rect.h - dy,
    });
  };

  const end = (e: React.PointerEvent) => {
    if (!dragModeRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    dragModeRef.current = null;
    pointerStartRef.current = null;
  };

  return (
    <div className="absolute inset-0 z-40 pointer-events-none">
      <div
        className="pointer-events-auto absolute"
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          borderRadius: maskRadiusPx,
          background: 'rgba(255, 255, 255, 0.18)',
          border: '1px solid rgba(255, 255, 255, 0.28)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          backdropFilter: 'blur(10px) saturate(120%)',
          WebkitBackdropFilter: 'blur(10px) saturate(120%)',
        }}
        onPointerDown={(e) => begin(e, 'move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {/* Close button */}
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }}
          className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center bg-white/80 border border-white/60 text-slate-700 hover:text-slate-900"
          title="删除蒙版"
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Resize handle (top-left) */}
        <div
          className="absolute top-1 left-1 w-4 h-4 rounded-full bg-white/70 border border-white/60 cursor-nwse-resize flex items-center justify-center"
          title="拖拽调整大小"
          onPointerDown={(e) => begin(e, 'resize-tl')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          <svg className="w-3 h-3 text-slate-600 rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {/* single centered slash */}
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 17L17 7" />
          </svg>
        </div>

        {/* Resize handle (bottom-right) */}
        <div
          className="absolute bottom-1 right-1 w-4 h-4 rounded-full bg-white/70 border border-white/60 cursor-nwse-resize flex items-center justify-center"
          title="拖拽调整大小"
          onPointerDown={(e) => begin(e, 'resize-br')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          <svg className="w-3 h-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {/* single centered slash */}
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 17L17 7" />
          </svg>
        </div>
      </div>
    </div>
  );
};


