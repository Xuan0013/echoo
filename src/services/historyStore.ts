import { Subtitle } from '../types';
import { LocalVideoMeta } from './localVideo';

export type HistoryKind = 'youtube' | 'local';

export type HistoryItem = {
  id: string;
  kind: HistoryKind;
  url: string;
  title?: string;
  customTitle?: string | null;
  thumbnailUrl?: string;
  localMeta?: LocalVideoMeta;
  subtitles: Subtitle[];
  starred: boolean;
  createdAt: number;
  updatedAt: number;
};

const DB_NAME = 'echoshadow';
const DB_VERSION = 2;
const STORE_NAME = 'history';
const LOCAL_VIDEOS_STORE = 'localVideos';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCAL_VIDEOS_STORE)) {
        const localStore = db.createObjectStore(LOCAL_VIDEOS_STORE, { keyPath: 'localKey' });
        localStore.createIndex('savedAt', 'savedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('starred', 'starred', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function idbGet<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result as T | undefined);
  });
}

function idbPut<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value as any);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve((req.result || []) as T[]);
  });
}

export function getHistoryDisplayTitle(item: HistoryItem): string {
  if (item.customTitle && item.customTitle.trim()) return item.customTitle.trim();
  if (item.title && item.title.trim()) return item.title.trim();
  if (item.kind === 'local') return item.localMeta?.name || '本地视频';
  return item.id;
}

export async function listHistory(): Promise<HistoryItem[]> {
  const db = await openDb();
  const items = await idbGetAll<HistoryItem>(db, STORE_NAME);
  db.close();
  return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getHistoryItem(id: string): Promise<HistoryItem | null> {
  const db = await openDb();
  const item = await idbGet<HistoryItem>(db, STORE_NAME, id);
  db.close();
  return item || null;
}

export async function upsertHistory(
  input: Omit<HistoryItem, 'createdAt' | 'updatedAt' | 'starred'> & {
    starred?: boolean;
  }
): Promise<HistoryItem> {
  const db = await openDb();
  const existing = await idbGet<HistoryItem>(db, STORE_NAME, input.id);
  const now = Date.now();
  const item: HistoryItem = {
    ...input,
    starred: existing?.starred ?? Boolean(input.starred),
    // 更新时保留自定义标题（除非本次显式传入）
    customTitle:
      input.customTitle !== undefined
        ? input.customTitle
        : existing?.customTitle ?? null,
    title: input.title || existing?.title,
    thumbnailUrl: input.thumbnailUrl || existing?.thumbnailUrl,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await idbPut(db, STORE_NAME, item);
  db.close();
  return item;
}

export async function setHistoryStarred(id: string, starred: boolean): Promise<HistoryItem | null> {
  const db = await openDb();
  const existing = await idbGet<HistoryItem>(db, STORE_NAME, id);
  if (!existing) {
    db.close();
    return null;
  }
  const updated: HistoryItem = { ...existing, starred, updatedAt: Date.now() };
  await idbPut(db, STORE_NAME, updated);
  db.close();
  return updated;
}

export async function updateHistoryTitle(id: string, customTitle: string | null): Promise<HistoryItem | null> {
  const db = await openDb();
  const existing = await idbGet<HistoryItem>(db, STORE_NAME, id);
  if (!existing) {
    db.close();
    return null;
  }
  const trimmed = customTitle?.trim() || null;
  const updated: HistoryItem = {
    ...existing,
    customTitle: trimmed,
    updatedAt: Date.now(),
  };
  await idbPut(db, STORE_NAME, updated);
  db.close();
  return updated;
}

export async function removeHistoryItem(id: string): Promise<void> {
  const db = await openDb();
  await idbDelete(db, STORE_NAME, id);
  db.close();
}

export async function fetchYouTubeTitle(url: string): Promise<string | null> {
  try {
    const resp = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    return data?.title ? String(data.title) : null;
  } catch {
    return null;
  }
}
