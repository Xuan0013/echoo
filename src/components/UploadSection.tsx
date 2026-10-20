import React, { useRef } from 'react';

interface UploadSectionProps {
  onFileSelect: (file: File) => void;
  isProcessing: boolean;
}

export const UploadSection: React.FC<UploadSectionProps> = ({ onFileSelect, isProcessing }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileSelect(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (isProcessing) return;
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
          onFileSelect(file);
        } else {
          alert("请上传有效的视频或音频文件。");
        }
      }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  return (
    <div 
      className={`border rounded-xl p-8 mb-8 text-center transition-colors duration-200 ${isProcessing ? 'border-slate-300 bg-slate-50 cursor-not-allowed' : 'cursor-pointer'}`}
      style={!isProcessing ? { 
        borderColor: '#E38134', 
        backgroundColor: '#ffffff'
      } : {}}
      onMouseEnter={(e) => {
        if (!isProcessing) {
          e.currentTarget.style.backgroundColor = '#ffffff';
          e.currentTarget.style.borderColor = '#E38134';
        }
      }}
      onMouseLeave={(e) => {
        if (!isProcessing) {
          e.currentTarget.style.backgroundColor = '#ffffff';
          e.currentTarget.style.borderColor = '#E38134';
        }
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onClick={() => !isProcessing && fileInputRef.current?.click()}
    >
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept="video/*,audio/*" 
        className="hidden" 
        disabled={isProcessing}
      />
      
      <div className="flex flex-col items-center justify-center" style={{ minHeight: '180px' }}>
        <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3 border" style={{ backgroundColor: '#ffffff', borderColor: '#E38134' }}>
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: '#E38134' }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-slate-800 font-fengyu mb-2">上传视频或音频</h3>
        <p className="text-slate-500 text-sm font-fengyu mb-2">点击浏览或拖拽上传 MP4、WebM、MP3 等格式</p>
        <p className="text-xs text-slate-400 font-fengyu">推荐：短片（50MB以下）以获得更快的处理速度</p>
      </div>
    </div>
  );
};