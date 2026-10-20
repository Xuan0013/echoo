import React, { useEffect, useMemo, useState } from 'react';
import {
  HistoryItem,
  getHistoryDisplayTitle,
  listHistory,
  removeHistoryItem,
  setHistoryStarred,
  updateHistoryTitle,
} from '../services/historyStore';
import { deleteLocalVideoFromServer } from '../services/localVideo';
import { deleteVideoCache } from '../services/videoService';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface HistoryPageProps {
  onOpen: (item: HistoryItem) => void;
  onBackHome: () => void;
}

export const HistoryPage: React.FC<HistoryPageProps> = ({ onOpen, onBackHome }) => {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'starred'>('all');
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [starringId, setStarringId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listHistory());
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const visibleItems = useMemo(() => {
    const list = filter === 'starred' ? items.filter((it) => it.starred) : items;
    return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [items, filter]);

  const handleRemove = async (id: string) => {
    const target = items.find((x) => x.id === id);
    if (!target) return;
    setRemoving(true);
    setError(null);
    try {
      if (target.kind === 'youtube') {
        try {
          await deleteVideoCache(target.url || `https://www.youtube.com/watch?v=${target.id}`);
        } catch (e) {
          console.warn('[History] delete server cache failed:', e);
        }
      } else if (target.kind === 'local') {
        try {
          await deleteLocalVideoFromServer(target.id);
        } catch (e) {
          console.warn('[History] delete local video file failed:', e);
        }
      }
      await removeHistoryItem(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
    } catch (e: any) {
      setError(e?.message || '删除失败');
    } finally {
      setRemoving(false);
    }
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <div className="w-full max-w-6xl mx-auto">
      <ConfirmDialog
        open={Boolean(pendingRemoveId)}
        title="删除历史记录"
        message="确定删除这条历史及其本地/服务器缓存吗？删除后无法从历史直接复用。"
        confirmText="确定"
        cancelText="取消"
        busy={removing}
        onCancel={() => {
          if (removing) return;
          setPendingRemoveId(null);
        }}
        onConfirm={async () => {
          if (!pendingRemoveId) return;
          await handleRemove(pendingRemoveId);
          setPendingRemoveId(null);
        }}
      />

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            onClick={onBackHome}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 font-fengyu"
          >
            返回首页
          </button>
          <div className="text-lg font-fengyu text-slate-900">历史记录</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 font-fengyu ${
              filter === 'all' ? 'bg-slate-50' : ''
            }`}
          >
            全部
          </button>
          <button
            onClick={() => setFilter('starred')}
            className={`px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 font-fengyu ${
              filter === 'starred' ? 'bg-slate-50' : ''
            }`}
          >
            已标星
          </button>
        </div>
      </div>

      {loading && <div className="text-sm text-slate-500 font-fengyu">加载中…</div>}
      {error && <div className="text-sm text-red-600 font-fengyu mb-3">{error}</div>}

      {!loading && visibleItems.length === 0 && (
        <div className="text-sm text-slate-500 font-fengyu">
          {filter === 'starred' ? '还没有标星的历史记录。' : '暂无历史。练习完成后会自动出现在这里。'}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleItems.map((it) => {
          const title = getHistoryDisplayTitle(it);
          const coverUrl =
            it.kind === 'youtube'
              ? it.thumbnailUrl || `https://i.ytimg.com/vi/${it.id}/hqdefault.jpg`
              : null;
          return (
            <div
              key={it.id}
              className="rounded-2xl overflow-hidden border border-transparent bg-white hover:border-slate-200 hover:shadow-md transition-all"
            >
              <button onClick={() => onOpen(it)} className="w-full text-left" title="打开">
                <div className="relative w-full bg-white rounded-t-2xl overflow-hidden" style={{ aspectRatio: '16 / 9' }}>
                  {coverUrl ? (
                    <img
                      src={coverUrl}
                      alt={title}
                      className="absolute inset-0 w-full h-full object-cover rounded-b-2xl"
                      loading="lazy"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-500 font-fengyu rounded-b-2xl bg-slate-200">
                      本地视频
                    </div>
                  )}
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setPendingRemoveId(it.id);
                    }}
                    className="absolute top-2 right-2 w-4 h-4 rounded-full flex items-center justify-center bg-black/60 hover:bg-black/80 transition-colors backdrop-blur-sm"
                    title="删除历史"
                  >
                    <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </button>

              <div className="px-3 pt-2 pb-3">
                {editingId === it.id ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      className="flex-1 min-w-0 text-base border border-slate-200 rounded-lg px-2 py-1 outline-none"
                      style={{
                        fontFamily: 'Roboto, sans-serif',
                        fontWeight: 500,
                        fontSize: '16px',
                        letterSpacing: '0.011em',
                        lineHeight: '1.4',
                        color: '#0f0f0f',
                      }}
                      autoFocus
                      disabled={savingTitle}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                    />
                    <button
                      onClick={async () => {
                        try {
                          setSavingTitle(true);
                          const saved = await updateHistoryTitle(it.id, draftTitle.trim() || null);
                          if (saved) {
                            setItems((prev) => prev.map((x) => (x.id === it.id ? saved : x)));
                          }
                          setEditingId(null);
                        } catch (err: any) {
                          setError(err?.message || '保存失败');
                        } finally {
                          setSavingTitle(false);
                        }
                      }}
                      disabled={savingTitle}
                      className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 font-fengyu disabled:opacity-50"
                    >
                      {savingTitle ? '保存中...' : '保存'}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      disabled={savingTitle}
                      className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 hover:bg-slate-50 font-fengyu disabled:opacity-50"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <div
                    className="line-clamp-2"
                    style={{
                      fontFamily: 'Roboto, sans-serif',
                      fontWeight: 500,
                      fontSize: '16px',
                      letterSpacing: '0.011em',
                      lineHeight: '1.4',
                      color: '#0f0f0f',
                    }}
                  >
                    {title}
                  </div>
                )}

                <div className="mt-2 flex items-center justify-between gap-2">
                  <div
                    style={{
                      fontFamily: 'Roboto, sans-serif',
                      fontSize: '12px',
                      color: '#606060',
                    }}
                  >
                    {formatDate(it.updatedAt || it.createdAt)}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={async () => {
                        if (starringId) return;
                        setStarringId(it.id);
                        try {
                          const updated = await setHistoryStarred(it.id, !it.starred);
                          if (updated) {
                            setItems((prev) => prev.map((x) => (x.id === it.id ? updated : x)));
                          }
                        } catch (err: any) {
                          setError(err?.message || '标星失败');
                        } finally {
                          setStarringId(null);
                        }
                      }}
                      className="w-8 h-8 rounded-lg border border-transparent hover:border-slate-200 hover:bg-slate-50 flex items-center justify-center"
                      title={it.starred ? '取消标星' : '标星'}
                      disabled={starringId === it.id}
                    >
                      <svg
                        className={`w-4 h-4 ${it.starred ? 'text-yellow-500' : 'text-slate-600'}`}
                        fill={it.starred ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                        />
                      </svg>
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(it.id);
                        setDraftTitle(getHistoryDisplayTitle(it));
                      }}
                      className="w-8 h-8 rounded-lg border border-transparent hover:border-slate-200 hover:bg-slate-50 flex items-center justify-center"
                      title="编辑标题"
                    >
                      <svg className="w-4 h-4 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
