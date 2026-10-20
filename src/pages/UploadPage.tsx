import React, { useState } from 'react';
import { UploadSection } from '../components/UploadSection';
import { ProcessStatus } from '../types';
import { isSupportedVideoPlatform } from '../utils/videoUrlParser';

interface UploadPageProps {
  onFileSelect: (file: File) => void;
  onUrlSubmit?: (url: string) => Promise<void>;
  status: ProcessStatus;
  errorMsg: string | null;
  processProgress?: { label: string; percent: number } | null;
}

export const UploadPage: React.FC<UploadPageProps> = ({
  onFileSelect,
  onUrlSubmit,
  status,
  errorMsg,
  processProgress = null,
}) => {
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [isUrlMode, setIsUrlMode] = useState<boolean>(true); // 默认显示"输入链接"模式
  const [isSubmittingUrl, setIsSubmittingUrl] = useState<boolean>(false);

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!videoUrl.trim() || !onUrlSubmit) return;

    setIsSubmittingUrl(true);
    try {
      await onUrlSubmit(videoUrl.trim());
    } catch (error) {
      console.error('URL submission error:', error);
    } finally {
      setIsSubmittingUrl(false);
    }
  };

  const isValidUrl = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return false;
      // 仅支持 YouTube
      return isSupportedVideoPlatform(url);
    } catch {
      return false;
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="mb-8">
        <h2
          className="text-slate-800 text-center font-fengyu whitespace-nowrap"
          style={{
            // 让字号自动适配：不换行、也不需要横向滚动
            fontSize: 'clamp(22px, 4.2vw, 34px)',
            letterSpacing: '0.03em',
          }}
        >
          很高兴 看到你今天也来练习<span style={{ fontFamily: 'Inter, sans-serif' }}>Shadowing</span> 🤗
        </h2>
      </div>

      {/* 上传框 */}
      {!isUrlMode ? (
        <UploadSection 
          onFileSelect={onFileSelect} 
          isProcessing={status === ProcessStatus.PROCESSING}
        />
      ) : (
        <div className="border rounded-xl p-8 mb-8" style={{ borderColor: '#E38134', backgroundColor: '#ffffff' }}>
          <form onSubmit={handleUrlSubmit} className="space-y-6" style={{ minHeight: '180px' }}>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2 font-fengyu">
                视频链接
              </label>
              <input
                type="text"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="请输入视频链接，例如：https://www.youtube.com/watch..."
                className="w-full px-4 py-3 border border-slate-300 rounded-lg outline-none font-fengyu"
                style={{ 
                  '--tw-ring-color': '#ef9b59',
                  '--tw-border-color': '#ef9b59'
                } as React.CSSProperties & { '--tw-ring-color': string; '--tw-border-color': string }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#ef9b59';
                  e.target.style.boxShadow = '0 0 0 2px rgba(239, 155, 89, 0.2)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = '';
                  e.target.style.boxShadow = '';
                }}
                disabled={isSubmittingUrl || status === ProcessStatus.PROCESSING}
              />
              <p className="mt-2 text-xs text-slate-500 font-fengyu">
                支持YouTube视频链接
              </p>
            </div>
            <button
              type="submit"
              disabled={!isValidUrl(videoUrl) || isSubmittingUrl || status === ProcessStatus.PROCESSING}
              className="w-full px-6 py-3 text-white rounded-lg transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed font-fengyu"
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
              {isSubmittingUrl ? '处理中...' : '提交链接'}
            </button>
          </form>
        </div>
      )}

      {/* 切换按钮 */}
      <div className="flex justify-center gap-4">
        <button
          onClick={() => setIsUrlMode(true)}
          className="px-4 py-2.5 rounded-full transition-all border flex items-center gap-2 text-sm"
          style={isUrlMode ? {
            backgroundColor: '#FFFBE5',
            borderColor: '#E38134',
            color: '#E38134'
          } : {
            backgroundColor: '#ffffff',
            borderColor: '#d1d5db',
            color: '#000000'
          }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span className="font-fengyu">输入链接</span>
        </button>
        <button
          onClick={() => setIsUrlMode(false)}
          className="px-4 py-2.5 rounded-full transition-all border flex items-center gap-2 text-sm"
          style={!isUrlMode ? {
            backgroundColor: '#FFFBE5',
            borderColor: '#E38134',
            color: '#E38134'
          } : {
            backgroundColor: '#ffffff',
            borderColor: '#d1d5db',
            color: '#000000'
          }}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <span className="font-fengyu">上传文件</span>
        </button>
      </div>
      
      {status === ProcessStatus.PROCESSING && (
        <div className="mt-6 p-4 rounded-xl border border-[#E38134]/40 bg-[#FFFBE5]/70">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-sm text-slate-800 font-fengyu truncate">
              {processProgress?.label || '处理中…'}
            </p>
            <span className="text-xs font-mono text-slate-500 shrink-0">
              {processProgress?.percent ?? 0}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/80 border border-slate-200 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300 ease-out"
              style={{
                width: `${Math.max(4, processProgress?.percent ?? 4)}%`,
                backgroundColor: '#E38134',
              }}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-500 font-fengyu">
            Whisper 转录可能需要几分钟，请保持页面打开。
          </p>
        </div>
      )}

      {status === ProcessStatus.ERROR && (
        <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-center font-fengyu">
          {errorMsg}
        </div>
      )}
    </div>
  );
};

