import React from 'react';

interface HeaderProps {
  onPreviewClick?: () => void;
  onHistoryClick?: () => void;
  onHomeClick?: () => void;
  onHelpClick?: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onPreviewClick, onHistoryClick, onHomeClick, onHelpClick }) => {
  return (
    <header className="bg-white sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-12 flex items-center justify-between">
        <div className="flex items-center">
          <button
            type="button"
            onClick={onHomeClick}
            className="flex items-center"
            title="返回首页"
          >
            <img 
              src="/echoo_logo.png" 
              alt="Echoo" 
              className="h-6 w-auto"
            />
          </button>
        </div>
        <div className="flex items-center gap-2">
          {onHistoryClick && (
            <button
              onClick={onHistoryClick}
              className="px-4 py-1.5 text-xs text-black rounded-lg transition-colors bg-transparent hover:bg-slate-200 font-fengyu font-thin"
              style={{ fontWeight: 100 }}
            >
              历史记录
            </button>
          )}
          {onPreviewClick && (
            <button
              onClick={onPreviewClick}
              className="px-4 py-1.5 text-xs text-black rounded-lg transition-colors bg-transparent hover:bg-slate-200 font-fengyu font-thin"
              style={{ fontWeight: 100 }}
            >
              预览练习页
            </button>
          )}
          {onHelpClick && (
            <button
              onClick={onHelpClick}
              className="px-4 py-1.5 text-xs text-black rounded-lg transition-colors bg-transparent hover:bg-slate-200 font-fengyu font-thin"
              style={{ fontWeight: 100 }}
            >
              帮助
            </button>
          )}
        </div>
      </div>
    </header>
  );
};