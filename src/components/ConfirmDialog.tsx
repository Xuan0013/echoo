import React, { useEffect } from 'react';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  mode?: 'screen' | 'container';
};

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmText = '确认',
  cancelText = '返回',
  onConfirm,
  onCancel,
  busy = false,
  mode = 'screen',
}) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const rootClass =
    mode === 'container'
      ? 'absolute inset-0 z-50 flex items-center justify-center'
      : 'fixed inset-0 z-[9999] flex items-center justify-center';

  return (
    <div className={rootClass}>
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative w-[92vw] max-w-sm rounded-2xl border border-slate-200 bg-white shadow-xl p-5">
        <div className="text-base font-fengyu text-slate-900">{title}</div>
        {message && <div className="mt-2 text-sm font-fengyu text-slate-600">{message}</div>}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 hover:bg-slate-50 font-fengyu disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-lg font-fengyu text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: '#ef9b59' }}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};


