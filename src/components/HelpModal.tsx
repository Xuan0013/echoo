import React, { useEffect, useState } from 'react';
import { API_BASE_URL } from '../services/config';

type HelpSection = 'api' | 'shortcuts' | 'shadowing';

interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  initialSection?: HelpSection;
}

const SECTIONS: { id: HelpSection; label: string }[] = [
  { id: 'api', label: 'API' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'shadowing', label: '更好的影子跟读' },
];

export const HelpModal: React.FC<HelpModalProps> = ({ open, onClose, initialSection = 'shortcuts' }) => {
  const [section, setSection] = useState<HelpSection>(initialSection);
  const [appid, setAppid] = useState('');
  const [apikey, setApikey] = useState('');
  const [apiLoading, setApiLoading] = useState(false);
  const [apiSaving, setApiSaving] = useState(false);
  const [apiMessage, setApiMessage] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [usingDevDefault, setUsingDevDefault] = useState(false);

  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || section !== 'api') return;
    let cancelled = false;
    (async () => {
      setApiLoading(true);
      setApiError(null);
      try {
        const res = await fetch(`${API_BASE_URL}/api/settings/niutrans`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(data.message || '读取配置失败');
        }
        if (!cancelled) {
          setAppid(data.appid || '');
          setApikey(data.apikey || '');
          setConfigured(Boolean(data.configured));
          setUsingDevDefault(Boolean(data.usingDevDefault));
        }
      } catch (e: any) {
        if (!cancelled) setApiError(e?.message || '读取配置失败');
      } finally {
        if (!cancelled) setApiLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, section]);

  const saveNiutrans = async () => {
    setApiSaving(true);
    setApiMessage(null);
    setApiError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/settings/niutrans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid: appid.trim(), apikey: apikey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.message || '保存失败');
      }
      setConfigured(true);
      setUsingDevDefault(false);
      setApiMessage('已保存，翻译将使用你填写的小牛 API');
    } catch (e: any) {
      setApiError(e?.message || '保存失败');
    } finally {
      setApiSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/35" onClick={onClose} />
      <div
        className="relative w-full max-w-3xl h-[min(560px,80vh)] bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden flex"
        role="dialog"
        aria-modal="true"
        aria-label="帮助"
      >
        <aside className="w-44 shrink-0 border-r border-slate-200 bg-slate-50 py-4 px-2 flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`text-left px-3 py-2 rounded-lg text-sm font-fengyu transition-colors ${
                section === s.id ? 'bg-white text-slate-900 shadow-sm border border-slate-200' : 'text-slate-600 hover:bg-white/70'
              }`}
            >
              {s.label}
            </button>
          ))}
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
            <div className="text-base font-fengyu text-slate-900">
              {SECTIONS.find((s) => s.id === section)?.label}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-500"
              title="关闭"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 text-sm text-slate-700 leading-relaxed font-fengyu">
            {section === 'api' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p>
                    转录使用本机 Whisper；双语翻译走小牛翻译 API。请在此填写你自己的凭证（保存在本机
                    <span className="font-mono text-xs"> data/server_data/niutrans.json </span>
                    ）。
                  </p>
                  <p className="text-slate-500 text-xs">
                    可在{' '}
                    <a
                      href="https://niutrans.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#E38134] underline underline-offset-2"
                    >
                      niutrans.com
                    </a>{' '}
                    申请 App ID 与 API Key。未配置时仍可练习原文，但不会自动翻译。
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 p-4 space-y-3 bg-slate-50/60">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500">配置状态</span>
                    <span className={configured ? 'text-emerald-600' : 'text-amber-600'}>
                      {apiLoading
                        ? '读取中…'
                        : usingDevDefault
                        ? '使用开发默认（可覆盖）'
                        : configured
                        ? '已配置'
                        : '未配置'}
                    </span>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-xs text-slate-500">App ID</span>
                    <input
                      type="text"
                      value={appid}
                      onChange={(e) => setAppid(e.target.value)}
                      disabled={apiLoading || apiSaving}
                      placeholder="例如 tExxxxxxxxxx"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm outline-none focus:border-[#E38134] focus:ring-2 focus:ring-[#E38134]/20"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs text-slate-500">API Key</span>
                    <input
                      type="password"
                      value={apikey}
                      onChange={(e) => setApikey(e.target.value)}
                      disabled={apiLoading || apiSaving}
                      placeholder="你的小牛 API Key"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm outline-none focus:border-[#E38134] focus:ring-2 focus:ring-[#E38134]/20"
                      autoComplete="off"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={saveNiutrans}
                    disabled={apiLoading || apiSaving || !appid.trim() || !apikey.trim()}
                    className="w-full py-2 rounded-lg text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ backgroundColor: '#ef9b59' }}
                  >
                    {apiSaving ? '保存中…' : '保存'}
                  </button>
                  {apiMessage && <p className="text-xs text-emerald-600">{apiMessage}</p>}
                  {apiError && <p className="text-xs text-red-600">{apiError}</p>}
                </div>
              </div>
            )}

            {section === 'shortcuts' && (
              <div className="space-y-4">
                <p>在练习页（焦点不在输入框时）可使用以下快捷键：</p>
                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 font-normal w-36">快捷键</th>
                        <th className="px-3 py-2 font-normal">功能</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2.5 font-mono text-slate-900">← / →</td>
                        <td className="px-3 py-2.5">跳到上一句 / 下一句</td>
                      </tr>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2.5 font-mono text-slate-900">Space</td>
                        <td className="px-3 py-2.5">播放 / 暂停</td>
                      </tr>
                      <tr className="border-t border-slate-100">
                        <td className="px-3 py-2.5 font-mono text-slate-900">长按 Y</td>
                        <td className="px-3 py-2.5">
                          按下开始录制当前句，松手结束并保存。若按住期间进入下一句，会自动保存上一句并开始录下一句。该句已有录音时，再次长按会覆盖原录音。
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {section === 'shadowing' && (
              <div className="space-y-3">
                <p>影子跟读（Shadowing）建议节奏：</p>
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>先听完整句，抓住重音与停顿</li>
                  <li>用「单句循环」跟读 2–3 遍，再放开听全文</li>
                  <li>长按 Y 录下自己的版本，回放对比节奏与清晰度</li>
                  <li>不求一次完美，优先跟上流畅度，再抠个别音素</li>
                </ol>
                <p className="text-slate-500 text-xs">可配合自由蒙版 / 字幕蒙版，减少视觉依赖，训练听觉跟读。</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
