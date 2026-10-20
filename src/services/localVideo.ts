import { API_BASE_URL, getApiUrl } from './config';

export type LocalVideoMeta = {
  name: string;
  type: string;
  size: number;
  lastModified: number;
};

export type UploadedLocalVideo = {
  localKey: string;
  url: string;
  meta: LocalVideoMeta & { filename?: string; savedAt?: number };
};

function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 为本地视频生成稳定 localKey：
 * - 服务器 data/local_videos/<localKey>.<ext>
 * - 历史记录 id
 */
export async function computeLocalVideoKey(file: File): Promise<string> {
  const chunkSize = 256 * 1024;
  const size = file.size;
  const head = await file.slice(0, Math.min(chunkSize, size)).arrayBuffer();
  const tail =
    size > chunkSize ? await file.slice(Math.max(0, size - chunkSize), size).arrayBuffer() : new ArrayBuffer(0);

  const meta = new TextEncoder().encode(`${size}:${file.type || ''}`);
  const combined = concatArrayBuffers([meta.buffer, head, tail]);
  const hex = await sha256Hex(combined);
  return `local_${size}_${hex.slice(0, 24)}`;
}

export async function uploadLocalVideoToServer(file: File, localKey?: string): Promise<UploadedLocalVideo> {
  const key = localKey || (await computeLocalVideoKey(file));
  const formData = new FormData();
  formData.append('file', file);
  formData.append('localKey', key);
  formData.append('lastModified', String(file.lastModified || Date.now()));

  const resp = await fetch(`${API_BASE_URL}/api/local-videos/upload`, {
    method: 'POST',
    body: formData,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success) {
    throw new Error(data.message || data.error || '本地视频上传失败');
  }

  return {
    localKey: data.localKey as string,
    url: getApiUrl(String(data.url || `/api/local-videos/${encodeURIComponent(data.localKey)}`)),
    meta: {
      name: data.meta?.name || file.name,
      type: data.meta?.type || file.type,
      size: Number(data.meta?.size || file.size || 0),
      lastModified: Number(data.meta?.lastModified || file.lastModified || Date.now()),
      ...(data.meta || {}),
    },
  };
}

export function getLocalVideoPlaybackUrl(localKey: string): string {
  return getApiUrl(`/api/local-videos/${encodeURIComponent(localKey)}`);
}

export async function checkLocalVideoExists(localKey: string): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE_URL}/api/local-videos/${encodeURIComponent(localKey)}/meta`);
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => ({}));
    return Boolean(data.success && data.exists);
  } catch {
    return false;
  }
}

export async function deleteLocalVideoFromServer(localKey: string): Promise<void> {
  const resp = await fetch(`${API_BASE_URL}/api/local-videos/${encodeURIComponent(localKey)}`, {
    method: 'DELETE',
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.success) {
    throw new Error(data.message || data.error || '删除本地视频失败');
  }
}
