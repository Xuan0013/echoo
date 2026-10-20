import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// 中间件（必须在路由之前注册，否则 req.body 为空）
app.use(cors());
// 收藏 local subtitles/translation 会比较大，放宽 JSON body 限制
app.use(express.json({ limit: '25mb' }));

// 确保目录存在
const dataRoot = path.join(__dirname, '../data');
const downloadsDir = path.join(dataRoot, 'downloads');
const cacheDir = path.join(dataRoot, 'cache');
const authDataDir = path.join(dataRoot, 'server_data');
const corpusVideosDir = path.join(dataRoot, 'corpus_videos');
// 本地上传视频持久化目录（开源本机版：不依赖浏览器 IndexedDB）
const localVideosDir = path.join(dataRoot, 'local_videos');

// 初始化目录
const initDirs = async () => {
  await fs.mkdir(downloadsDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(authDataDir, { recursive: true });
  await fs.mkdir(corpusVideosDir, { recursive: true });
  await fs.mkdir(localVideosDir, { recursive: true });
};
initDirs().catch(console.error);

const isSafeLocalKey = (key) => typeof key === 'string' && /^[a-zA-Z0-9_-]+$/.test(key) && key.length <= 120;

const localVideoMetaPath = (localKey) => path.join(localVideosDir, `${localKey}.json`);

const findLocalVideoFile = async (localKey) => {
  if (!isSafeLocalKey(localKey)) return null;
  try {
    const files = await fs.readdir(localVideosDir);
    const match = files.find(
      (f) => f.startsWith(`${localKey}.`) && !f.endsWith('.json') && !f.endsWith('.json.tmp')
    );
    return match ? path.join(localVideosDir, match) : null;
  } catch {
    return null;
  }
};

// -------------------------
// Auth (real, file-backed)
// -------------------------
const USERS_FILE = path.join(authDataDir, 'users.json');
const SESSIONS_FILE = path.join(authDataDir, 'sessions.json');
const RESETS_FILE = path.join(authDataDir, 'password_resets.json');
const INVITES_FILE = path.join(authDataDir, 'invites.json');
const FAVORITES_FILE = path.join(authDataDir, 'favorites.json');
const CORPUS_FILE = path.join(authDataDir, 'corpus.json');

// 邀请码字符集：8位，数字+字母，且不含 0/O、1/l/I（这里统一用大写字母避免小写 l）
const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0,1,I,O
const INVITE_LEN = 8;

const isValidInviteFormat = (code) => {
  if (!code) return false;
  const normalized = String(code).trim().toUpperCase();
  if (normalized.length !== INVITE_LEN) return false;
  // must be only allowed chars
  for (const ch of normalized) {
    if (!INVITE_ALPHABET.includes(ch)) return false;
  }
  // must contain at least one digit and one letter
  const hasDigit = /[2-9]/.test(normalized);
  const hasLetter = /[A-Z]/.test(normalized);
  return hasDigit && hasLetter;
};

const generateInviteCode = () => {
  for (let tries = 0; tries < 1000; tries++) {
    let code = '';
    for (let i = 0; i < INVITE_LEN; i++) {
      const idx = crypto.randomInt(0, INVITE_ALPHABET.length);
      code += INVITE_ALPHABET[idx];
    }
    if (isValidInviteFormat(code)) return code;
  }
  throw new Error('Failed to generate invite code');
};

// 简单串行锁：避免并发读写 invites/users 文件导致冲突
let invitesLock = Promise.resolve();
const withInvitesLock = async (fn) => {
  const prev = invitesLock;
  let release;
  invitesLock = new Promise((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
};

// Favorites store lock (file-backed DB)
let favoritesLock = Promise.resolve();
const withFavoritesLock = async (fn) => {
  const prev = favoritesLock;
  let release;
  favoritesLock = new Promise((r) => (release = r));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
};

const readFavoritesDb = async () => {
  const db = await readJsonSafe(FAVORITES_FILE, { users: {} });
  if (!db || typeof db !== 'object') return { users: {} };
  if (!db.users || typeof db.users !== 'object') db.users = {};
  return db;
};

const getCacheStatusByVideoId = async (videoId) => {
  const dir = path.join(cacheDir, videoId);
  try {
    const files = await fs.readdir(dir);
    const status = {
      audio: files.includes('audio.mp3'),
      video: files.includes('video.mp4'),
      subtitles: files.includes('subtitles.json'),
      translations: files.filter((f) => f.startsWith('translation_')).map((f) => f.replace('translation_', '').replace('.json', '')),
    };
    return status;
  } catch {
    return { audio: false, video: false, subtitles: false, translations: [] };
  }
};

const buildYoutubeWatchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;
const buildYoutubeThumbnailUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

const probeDurationSec = async (ffprobePath, mediaPath) => {
  try {
    const cmd = `"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mediaPath}"`;
    const { stdout } = await execAsync(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 });
    const sec = Number.parseFloat(String(stdout || '').trim());
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return Math.max(1, Math.round(sec));
  } catch {
    return null;
  }
};

const getCachedDurationSecByVideoId = async (videoId) => {
  try {
    const ffprobePath = await findTool('ffprobe', [
      '/opt/homebrew/bin/ffprobe',
      '/usr/local/bin/ffprobe',
      '/usr/bin/ffprobe',
      `${process.env.HOME}/bin/ffprobe`,
    ]);
    if (!ffprobePath) return null;

    const videoPath = path.join(cacheDir, videoId, 'video.mp4');
    const audioPath = path.join(cacheDir, videoId, 'audio.mp3');
    try {
      await fs.access(videoPath);
      const d = await probeDurationSec(ffprobePath, videoPath);
      if (d) return d;
    } catch {}
    try {
      await fs.access(audioPath);
      const d = await probeDurationSec(ffprobePath, audioPath);
      if (d) return d;
    } catch {}
    return null;
  } catch {
    return null;
  }
};

const buildFavoriteCacheSummary = async (it) => {
  // YouTube：缓存由 cache/<videoId>/... 决定
  if (it?.kind === 'youtube' || it?.platform === 'youtube') {
    return await getCacheStatusByVideoId(it.videoId);
  }
  // Corpus：视频在 corpus_videos，属于可播放视频；这里只反映字幕/译文信息是否存在
  if (it?.kind === 'corpus' || it?.platform === 'corpus' || String(it?.url || '').startsWith('corpus://')) {
    const subtitlesOk = Array.isArray(it?.subtitles) && it.subtitles.length > 0;
    const hasZh =
      subtitlesOk &&
      it.subtitles.some((s) => typeof s?.translation === 'string' && s.translation.trim().length > 0);
    return { audio: false, video: true, subtitles: subtitlesOk, translations: hasZh ? ['zh'] : [] };
  }
  // Local：服务器不存视频；这里只反映“服务器已存字幕/译文信息”
  const subtitlesOk = Array.isArray(it?.subtitles) && it.subtitles.length > 0;
  const hasZh =
    subtitlesOk &&
    it.subtitles.some((s) => typeof s?.translation === 'string' && s.translation.trim().length > 0);
  return { audio: false, video: false, subtitles: subtitlesOk, translations: hasZh ? ['zh'] : [] };
};

async function readCorpusDbForFavorites() {
  const db = await readJsonSafe(CORPUS_FILE, { items: {} });
  if (!db || typeof db !== 'object') return { items: {} };
  if (!db.items || typeof db.items !== 'object') db.items = {};
  return db;
}

// 收藏：列表
app.get('/api/favorites', requireAuth, async (req, res) => {
  try {
    const db = await readFavoritesDb();
    const userId = req.auth.userId;
    const user = db.users[userId] || { items: {} };
    const items = Object.values(user.items || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // attach cache status + UI metadata (thumbnail/duration)
    const withStatus = await Promise.all(
      items.map(async (it) => {
        // 列表接口尽量轻量：local/corpus 收藏的字幕/译文较大，详情请走 /api/favorites/:videoId
        const lite = { ...it };
        if (lite && (lite.kind === 'local' || lite.platform === 'local' || lite.kind === 'corpus' || lite.platform === 'corpus')) {
          delete lite.subtitles;
        }

        if (lite && (lite.kind === 'youtube' || lite.platform === 'youtube')) {
          if (!lite.thumbnailUrl) lite.thumbnailUrl = buildYoutubeThumbnailUrl(lite.videoId);
          if (lite.durationSec === undefined) {
            lite.durationSec = await getCachedDurationSecByVideoId(lite.videoId);
          }
        }

        // expose custom title to frontend
        if (lite && lite.customTitle && !lite.title) {
          lite.title = lite.customTitle;
        }

        // corpus: expose cover url
        if (lite && (lite.kind === 'corpus' || lite.platform === 'corpus' || String(lite.url || '').startsWith('corpus://'))) {
          lite.coverUrl = `/api/corpus/cover/${encodeURIComponent(lite.videoId)}`;
        }

        return { ...lite, cache: await buildFavoriteCacheSummary(it) };
      })
    );

    return res.json({ success: true, items: withStatus });
  } catch (e) {
    console.error('List favorites error:', e);
    return res.status(500).json({ success: false, message: '获取收藏失败' });
  }
});

// 收藏：是否已收藏
app.get('/api/favorites/has', requireAuth, async (req, res) => {
  try {
    const kind = String(req.query?.kind || '').trim();
    const url = String(req.query?.url || '').trim();
    const videoIdFromQuery = String(req.query?.videoId || '').trim();
    const videoId =
      kind === 'local'
        ? videoIdFromQuery
        : kind === 'corpus'
        ? (videoIdFromQuery || (url.startsWith('corpus://') ? url.replace('corpus://', '') : ''))
        : (videoIdFromQuery || getVideoId(url));
    if (!videoId) return res.json({ success: true, favorited: false });

    const db = await readFavoritesDb();
    const userId = req.auth.userId;
    const user = db.users[userId] || { items: {} };
    const favorited = Boolean(user.items && user.items[videoId]);
    return res.json({ success: true, favorited });
  } catch (e) {
    console.error('Has favorite error:', e);
    return res.status(500).json({ success: false, message: '查询收藏失败' });
  }
});

// 收藏：详情（用于 local 收藏拿字幕/译文）
// 注意：必须放在 /api/favorites/has 之后，避免被 :videoId 路由抢占
app.get('/api/favorites/:videoId', requireAuth, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: '无效的参数' });
    const db = await readFavoritesDb();
    const userId = req.auth.userId;
    const user = db.users[userId] || { items: {} };
    const it = user.items ? user.items[videoId] : null;
    if (!it) return res.status(404).json({ success: false, message: '收藏不存在' });
    const out = { ...it };
    if (out && (out.kind === 'corpus' || out.platform === 'corpus' || String(out.url || '').startsWith('corpus://'))) {
      out.coverUrl = `/api/corpus/cover/${encodeURIComponent(out.videoId)}`;
    }
    return res.json({ success: true, item: { ...out, cache: await buildFavoriteCacheSummary(it) } });
  } catch (e) {
    console.error('Get favorite error:', e);
    return res.status(500).json({ success: false, message: '获取收藏失败' });
  }
});

// 收藏：更新（目前仅支持更新自定义标题）
app.patch('/api/favorites/:videoId', requireAuth, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: '无效的参数' });
    const rawTitle = req.body?.customTitle;
    // 处理 customTitle：null/undefined -> null，空字符串 -> null，其他 -> trim后的字符串
    let customTitle = null;
    if (rawTitle !== null && rawTitle !== undefined) {
      const trimmed = String(rawTitle).trim();
      customTitle = trimmed.length > 0 ? trimmed : null;
    }

    if (customTitle !== null) {
      if (customTitle.length > 80) {
        return res.status(400).json({ success: false, message: '标题太长（最多80字）' });
      }
    }

    const updated = await withFavoritesLock(async () => {
      const db = await readFavoritesDb();
      const userId = req.auth.userId;
      const user = db.users[userId] || { items: {} };
      if (!user.items || !user.items[videoId]) {
        console.error(`[Update favorite] Item not found: userId=${userId}, videoId=${videoId}`);
        return null;
      }
      const it = user.items[videoId];
      if (customTitle === null) {
        delete it.customTitle;
      } else {
        it.customTitle = customTitle;
      }
      it.updatedAt = Date.now();
      db.users[userId] = user;
      await writeJsonAtomic(FAVORITES_FILE, db);
      return it;
    });

    if (!updated) return res.status(404).json({ success: false, message: '收藏不存在' });
    // 确保返回的 item 包含 title 字段（优先使用 customTitle）
    const itemWithTitle = { ...updated };
    if (itemWithTitle.customTitle) {
      itemWithTitle.title = itemWithTitle.customTitle;
    }
    return res.json({ success: true, item: { ...itemWithTitle, cache: await buildFavoriteCacheSummary(updated) } });
  } catch (e) {
    console.error('[Update favorite] Error:', e);
    console.error('[Update favorite] Stack:', e?.stack);
    return res.status(500).json({ success: false, message: '更新失败: ' + (e?.message || '未知错误') });
  }
});

// 收藏：新增
app.post('/api/favorites', requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    const kind = String(req.body?.kind || '').trim();

    // 0) Corpus favorite: reference corpus video, playback from server
    if (kind === 'corpus') {
      const corpusId = String(req.body?.videoId || '').trim();
      if (!corpusId) return res.status(400).json({ success: false, message: '缺少语料库视频ID' });

      const corpusDb = await readCorpusDbForFavorites();
      const corpusItem = corpusDb.items ? corpusDb.items[corpusId] : null;
      if (!corpusItem) return res.status(404).json({ success: false, message: '语料库项不存在' });

      const item = {
        kind: 'corpus',
        videoId: corpusId,
        url: `corpus://${corpusId}`,
        platform: 'corpus',
        localMeta: corpusItem.localMeta || {},
        subtitles: corpusItem.subtitles || [],
        createdAt: now,
        updatedAt: now,
      };

      const saved = await withFavoritesLock(async () => {
        const db = await readFavoritesDb();
        const userId = req.auth.userId;
        if (!db.users[userId]) db.users[userId] = { items: {} };
        if (!db.users[userId].items) db.users[userId].items = {};
        db.users[userId].items[corpusId] = item;
        await writeJsonAtomic(FAVORITES_FILE, db);
        return item;
      });

      const out = { ...saved, coverUrl: `/api/corpus/cover/${encodeURIComponent(corpusId)}` };
      return res.json({ success: true, item: { ...out, cache: await buildFavoriteCacheSummary(saved) }, missing: [] });
    }

    // 1) Local favorite (server does NOT store the video file; only metadata + subtitles/translation)
    if (kind === 'local') {
      const localKey = String(req.body?.localKey || req.body?.videoId || '').trim();
      const meta = req.body?.meta || {};
      const subtitles = req.body?.subtitles;
      if (!localKey) return res.status(400).json({ success: false, message: '缺少本地视频标识' });
      if (!Array.isArray(subtitles) || subtitles.length === 0) {
        return res.status(400).json({ success: false, message: '缺少字幕数据，无法收藏' });
      }

      const item = {
        kind: 'local',
        videoId: localKey,
        url: `local://${localKey}`,
        platform: 'local',
        localMeta: {
          name: String(meta?.name || '').trim(),
          type: String(meta?.type || '').trim(),
          size: Number(meta?.size || 0),
          lastModified: Number(meta?.lastModified || 0),
        },
        subtitles,
        createdAt: now,
        updatedAt: now,
      };

      const saved = await withFavoritesLock(async () => {
        const db = await readFavoritesDb();
        const userId = req.auth.userId;
        if (!db.users[userId]) db.users[userId] = { items: {} };
        if (!db.users[userId].items) db.users[userId].items = {};
        db.users[userId].items[localKey] = item;
        await writeJsonAtomic(FAVORITES_FILE, db);
        return item;
      });

      return res.json({ success: true, item: { ...saved, cache: await buildFavoriteCacheSummary(saved) }, missing: [] });
    }

    // 2) YouTube favorite (existing behavior)
    const urlRaw = req.body?.url;
    const url = String(urlRaw || '').trim();
    if (!url) return res.status(400).json({ success: false, message: '请提供视频链接' });

    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    if (!isYouTube) return res.status(400).json({ success: false, message: '仅支持Youtube视频链接' });

    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: '无效的视频链接' });

    const item = {
      kind: 'youtube',
      videoId,
      url: buildYoutubeWatchUrl(videoId),
      thumbnailUrl: buildYoutubeThumbnailUrl(videoId),
      customTitle: null,
      platform: 'youtube',
      createdAt: now,
      updatedAt: now,
    };

    const saved = await withFavoritesLock(async () => {
      const db = await readFavoritesDb();
      const userId = req.auth.userId;
      if (!db.users[userId]) db.users[userId] = { items: {} };
      if (!db.users[userId].items) db.users[userId].items = {};
      db.users[userId].items[videoId] = item;
      await writeJsonAtomic(FAVORITES_FILE, db);
      return item;
    });

    const cache = await getCacheStatusByVideoId(videoId);
    const missing = [];
    if (!cache.audio) missing.push('audio');
    if (!cache.subtitles) missing.push('subtitles');
    if (!cache.translations.includes('zh')) missing.push('translation_zh');

    return res.json({ success: true, item: { ...saved, cache }, missing });
  } catch (e) {
    console.error('Add favorite error:', e);
    return res.status(500).json({ success: false, message: '收藏失败' });
  }
});

// 收藏：删除
app.delete('/api/favorites/:videoId', requireAuth, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: '无效的参数' });

    await withFavoritesLock(async () => {
      const db = await readFavoritesDb();
      const userId = req.auth.userId;
      if (!db.users[userId] || !db.users[userId].items) return;
      delete db.users[userId].items[videoId];
      await writeJsonAtomic(FAVORITES_FILE, db);
    });

    return res.json({ success: true });
  } catch (e) {
    console.error('Remove favorite error:', e);
    return res.status(500).json({ success: false, message: '取消收藏失败' });
  }
});

async function readJsonSafe(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

const readInvites = async () => {
  const data = await readJsonSafe(INVITES_FILE, { codes: {} });
  if (!data || typeof data !== 'object') return { codes: {} };
  if (!data.codes || typeof data.codes !== 'object') return { codes: {} };
  return data;
};

const normalizeUsername = (u) => (u || '').trim().toLowerCase();

const scryptAsync = (password, salt, keylen = 64) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey);
    });
  });

const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString('base64');
  const dk = await scryptAsync(password, salt, 64);
  return { salt, hash: Buffer.from(dk).toString('base64') };
};

const verifyPassword = async (password, salt, expectedHash) => {
  const dk = await scryptAsync(password, salt, 64);
  const actual = Buffer.from(dk).toString('base64');
  // timing safe compare
  const a = Buffer.from(actual);
  const b = Buffer.from(expectedHash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const newToken = () => crypto.randomBytes(32).toString('base64url');

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

  // 开源本地版：无登录态时按本地访客处理，避免收藏/语料库接口 401
  if (!token) {
    req.auth = { userId: 'local-guest', username: 'guest' };
    return next();
  }

  const sessions = await readJsonSafe(SESSIONS_FILE, {});
  const session = sessions[token];
  if (!session) {
    req.auth = { userId: 'local-guest', username: 'guest' };
    return next();
  }
  if (session.expiresAt && Date.now() > session.expiresAt) {
    delete sessions[token];
    await writeJsonAtomic(SESSIONS_FILE, sessions);
    req.auth = { userId: 'local-guest', username: 'guest' };
    return next();
  }

  req.auth = session;
  next();
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const usernameRaw = req.body?.username;
    const password = req.body?.password;
    const inviteCodeRaw = req.body?.inviteCode;
    const username = normalizeUsername(usernameRaw);
    const inviteCode = String(inviteCodeRaw || '').trim().toUpperCase();

    if (!username || !password || !inviteCode) {
      return res.status(400).json({ success: false, message: 'Username, password and inviteCode are required' });
    }
    if (username.length < 3 || username.length > 12) {
      return res.status(400).json({ success: false, message: '用户名长度需要在3-12个字符之间' });
    }
    if (password.length < 6 || password.length > 16) {
      return res.status(400).json({ success: false, message: '密码长度需要在6-16个字符之间' });
    }
    if (!isValidInviteFormat(inviteCode)) {
      return res.status(400).json({ success: false, message: '无效的邀请码' });
    }

    // 在锁里完成：校验邀请码未使用 -> 创建用户 -> 消耗邀请码
    const result = await withInvitesLock(async () => {
      const invites = await readInvites();
      const record = invites.codes[inviteCode];
      if (!record) {
        return { ok: false, status: 400, message: '无效的邀请码' };
      }
      if (record.used) {
        return { ok: false, status: 409, message: '该邀请码已被使用' };
      }

      const users = await readJsonSafe(USERS_FILE, []);
      // 用户名不区分大小写（兼容历史数据：users.json 里可能存在大写）
      if (users.some((u) => normalizeUsername(u.username) === username)) {
        return { ok: false, status: 409, message: '用户名已存在' };
      }

      const { salt, hash } = await hashPassword(password);
      const user = {
        id: crypto.randomUUID(),
        username,
        salt,
        hash,
        createdAt: Date.now(),
      };
      users.push(user);

      // mark invite as used
      invites.codes[inviteCode] = {
        ...(record || {}),
        used: true,
        usedByUserId: user.id,
        usedByUsername: user.username,
        usedAt: Date.now(),
      };

      await writeJsonAtomic(USERS_FILE, users);
      await writeJsonAtomic(INVITES_FILE, invites);
      return { ok: true, user };
    });

    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }

    return res.json({ success: true, user: { id: result.user.id, username: result.user.username } });
  } catch (e) {
    console.error('Register error:', e);
    return res.status(500).json({ success: false, message: 'Register failed' });
  }
});

// 生成邀请码（需要管理员 key；本地发放使用）
// curl -X POST http://localhost:3001/api/auth/invites/generate -H 'Content-Type: application/json' -H 'X-Admin-Key: your_key' -d '{"count":10}'
app.post('/api/auth/invites/generate', async (req, res) => {
  try {
    const adminKey = process.env.ECHOO_ADMIN_KEY;
    const providedKey = String(req.headers['x-admin-key'] || '');
    if (!adminKey) {
      return res.status(500).json({ success: false, message: 'Admin key not configured' });
    }
    if (providedKey !== adminKey) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const countRaw = req.body?.count;
    const count = Math.max(1, Math.min(1000, Number.isFinite(Number(countRaw)) ? Number(countRaw) : 10));

    const codes = await withInvitesLock(async () => {
      const invites = await readInvites();
      const out = [];
      for (let i = 0; i < count; i++) {
        let code = generateInviteCode();
        while (invites.codes[code]) code = generateInviteCode();
        invites.codes[code] = { used: false, createdAt: Date.now() };
        out.push(code);
      }
      await writeJsonAtomic(INVITES_FILE, invites);
      return out;
    });

    return res.json({ success: true, codes });
  } catch (e) {
    console.error('Generate invites error:', e);
    return res.status(500).json({ success: false, message: 'Generate invites failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }

    const users = await readJsonSafe(USERS_FILE, []);
    // 用户名不区分大小写（兼容历史数据）
    const user = users.find((u) => normalizeUsername(u.username) === username);
    if (!user) {
      return res.status(401).json({ success: false, message: '用户名或密码不正确' });
    }

    const ok = await verifyPassword(password, user.salt, user.hash);
    if (!ok) {
      return res.status(401).json({ success: false, message: '用户名或密码不正确' });
    }

    const token = newToken();
    const sessions = await readJsonSafe(SESSIONS_FILE, {});
    sessions[token] = {
      userId: user.id,
      username: user.username,
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    };
    await writeJsonAtomic(SESSIONS_FILE, sessions);

    return res.json({ success: true, token, user: { id: user.id, username: user.username } });
  } catch (e) {
    console.error('Login error:', e);
    return res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// 忘记密码：用“注册时消耗的邀请码”验证后直接改密码
app.post('/api/auth/reset-with-invite', async (req, res) => {
  try {
    const usernameRaw = req.body?.username;
    const inviteCodeRaw = req.body?.inviteCode;
    const newPassword = req.body?.newPassword;
    const username = normalizeUsername(usernameRaw);
    const inviteCode = String(inviteCodeRaw || '').trim().toUpperCase();

    if (!username || !inviteCode || !newPassword) {
      return res.status(400).json({ success: false, message: '请填写完整信息' });
    }
    if (username.length < 3 || username.length > 12) {
      return res.status(400).json({ success: false, message: '用户名长度需要在3-12个字符之间' });
    }
    if (newPassword.length < 6 || newPassword.length > 16) {
      return res.status(400).json({ success: false, message: '密码长度需要在6-16个字符之间' });
    }
    if (!isValidInviteFormat(inviteCode)) {
      return res.status(400).json({ success: false, message: '无效的邀请码' });
    }

    const result = await withInvitesLock(async () => {
      const users = await readJsonSafe(USERS_FILE, []);
      const userIdx = users.findIndex((u) => normalizeUsername(u.username) === username);
      if (userIdx === -1) {
        return { ok: false, status: 404, message: '用户名不存在' };
      }

      const invites = await readInvites();
      const record = invites.codes[inviteCode];

      // 不泄漏过多信息：不存在/未使用/不匹配 都统一提示“无效的邀请码”
      if (!record || !record.used) {
        return { ok: false, status: 400, message: '无效的邀请码' };
      }

      const matched =
        (record.usedByUserId && record.usedByUserId === users[userIdx].id) ||
        (record.usedByUsername && normalizeUsername(record.usedByUsername) === username);

      if (!matched) {
        return { ok: false, status: 400, message: '无效的邀请码' };
      }

      const { salt, hash } = await hashPassword(newPassword);
      users[userIdx].salt = salt;
      users[userIdx].hash = hash;
      users[userIdx].updatedAt = Date.now();
      await writeJsonAtomic(USERS_FILE, users);
      return { ok: true };
    });

    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('Reset-with-invite error:', e);
    return res.status(500).json({ success: false, message: '修改密码失败，请稍后再试' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  return res.json({ success: true, user: { id: req.auth.userId, username: req.auth.username } });
});


app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return res.json({ success: true });
  const sessions = await readJsonSafe(SESSIONS_FILE, {});
  delete sessions[token];
  await writeJsonAtomic(SESSIONS_FILE, sessions);
  return res.json({ success: true });
});

// 忘记密码：生成重置 token（生产环境应通过邮件/短信发送；这里先返回 token 方便你接入 UI 测试）
app.post('/api/auth/request-reset', async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    if (!username) return res.status(400).json({ success: false, message: 'Username is required' });

    const users = await readJsonSafe(USERS_FILE, []);
    const user = users.find((u) => normalizeUsername(u.username) === username);
    if (!user) {
      // 不泄漏是否存在
      return res.json({ success: true });
    }

    const resets = await readJsonSafe(RESETS_FILE, {});
    const token = newToken();
    resets[token] = { userId: user.id, username: user.username, expiresAt: Date.now() + 15 * 60 * 1000 };
    await writeJsonAtomic(RESETS_FILE, resets);
    return res.json({ success: true, token });
  } catch (e) {
    console.error('Request reset error:', e);
    return res.status(500).json({ success: false, message: 'Request reset failed' });
  }
});

app.post('/api/auth/reset', async (req, res) => {
  try {
    const token = (req.body?.token || '').trim();
    const newPassword = req.body?.newPassword;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and newPassword are required' });
    }
    if (newPassword.length < 6 || newPassword.length > 128) {
      return res.status(400).json({ success: false, message: 'Password must be 6-128 characters' });
    }

    const resets = await readJsonSafe(RESETS_FILE, {});
    const record = resets[token];
    if (!record || (record.expiresAt && Date.now() > record.expiresAt)) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    const users = await readJsonSafe(USERS_FILE, []);
    const idx = users.findIndex((u) => u.id === record.userId);
    if (idx === -1) {
      return res.status(400).json({ success: false, message: 'Invalid token' });
    }

    const { salt, hash } = await hashPassword(newPassword);
    users[idx].salt = salt;
    users[idx].hash = hash;
    users[idx].updatedAt = Date.now();
    await writeJsonAtomic(USERS_FILE, users);

    delete resets[token];
    await writeJsonAtomic(RESETS_FILE, resets);

    return res.json({ success: true });
  } catch (e) {
    console.error('Reset error:', e);
    return res.status(500).json({ success: false, message: 'Reset failed' });
  }
});

// 提取视频ID的辅助函数
const getVideoId = (url) => {
  if (!url) return null;
  console.log(`[Cache] Extracting ID from URL: ${url}`);
  try {
    const urlObj = new URL(url);
    let id = null;
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      if (url.includes('youtu.be')) {
        id = urlObj.pathname.substring(1);
      } else {
        id = urlObj.searchParams.get('v');
      }
    }
    console.log(`[Cache] Extracted ID: ${id}`);
    return id;
  } catch (e) {
    console.error(`[Cache] URL parsing error: ${e.message}`);
    return null;
  }
};

// 中间件已在文件顶部注册

// 配置 multer 用于文件上传（本机开源版放宽体积限制）
const upload = multer({ 
  dest: downloadsDir,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// -------------------------
// Local videos (disk-backed)
// -------------------------
app.post('/api/local-videos/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const localKey = String(req.body?.localKey || '').trim();
    if (!isSafeLocalKey(localKey)) {
      try { await fs.unlink(req.file.path); } catch {}
      return res.status(400).json({ success: false, message: '无效的 localKey' });
    }

    const ext = path.extname(req.file.originalname || '') || '.mp4';
    const destPath = path.join(localVideosDir, `${localKey}${ext}`);
    const meta = {
      localKey,
      name: String(req.file.originalname || 'local-video'),
      type: String(req.file.mimetype || ''),
      size: Number(req.file.size || 0),
      lastModified: Number(req.body?.lastModified || Date.now()),
      savedAt: Date.now(),
      filename: `${localKey}${ext}`,
    };

    // 同 key 已存在：先删旧文件再写入，避免扩展名不一致残留
    try {
      const existing = await findLocalVideoFile(localKey);
      if (existing && existing !== destPath) {
        await fs.unlink(existing).catch(() => {});
      }
    } catch {}

    await fs.rename(req.file.path, destPath);
    await writeJsonAtomic(localVideoMetaPath(localKey), meta);

    return res.json({
      success: true,
      localKey,
      url: `/api/local-videos/${encodeURIComponent(localKey)}`,
      meta,
    });
  } catch (error) {
    console.error('Local video upload error:', error);
    return res.status(500).json({ success: false, message: error.message || '上传失败' });
  }
});

app.get('/api/local-videos/:localKey', async (req, res) => {
  try {
    const localKey = String(req.params.localKey || '').trim();
    const filePath = await findLocalVideoFile(localKey);
    if (!filePath) return res.status(404).json({ success: false, message: '本地视频不存在' });

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.webm' ? 'video/webm' :
      ext === '.mov' ? 'video/quicktime' :
      ext === '.mkv' ? 'video/x-matroska' :
      'video/mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    return res.sendFile(filePath);
  } catch (error) {
    console.error('Local video serve error:', error);
    return res.status(500).json({ success: false, message: '读取本地视频失败' });
  }
});

app.get('/api/local-videos/:localKey/meta', async (req, res) => {
  try {
    const localKey = String(req.params.localKey || '').trim();
    if (!isSafeLocalKey(localKey)) {
      return res.status(400).json({ success: false, message: '无效的 localKey' });
    }
    const filePath = await findLocalVideoFile(localKey);
    if (!filePath) return res.status(404).json({ success: false, message: '本地视频不存在' });
    const meta = await readJsonSafe(localVideoMetaPath(localKey), null);
    return res.json({
      success: true,
      exists: true,
      url: `/api/local-videos/${encodeURIComponent(localKey)}`,
      meta: meta || { localKey },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: '读取失败' });
  }
});

app.delete('/api/local-videos/:localKey', async (req, res) => {
  try {
    const localKey = String(req.params.localKey || '').trim();
    if (!isSafeLocalKey(localKey)) {
      return res.status(400).json({ success: false, message: '无效的 localKey' });
    }
    const filePath = await findLocalVideoFile(localKey);
    if (filePath) await fs.unlink(filePath).catch(() => {});
    await fs.unlink(localVideoMetaPath(localKey)).catch(() => {});
    return res.json({ success: true });
  } catch (error) {
    console.error('Local video delete error:', error);
    return res.status(500).json({ success: false, message: '删除失败' });
  }
});

// 清理旧文件的函数
const cleanupOldFiles = async () => {
  try {
    const files = await fs.readdir(downloadsDir);
    const now = Date.now();
    for (const file of files) {
      // 不清理 cache 目录，只清理 downloads 目录中的临时文件
      const filePath = path.join(downloadsDir, file);
      const stats = await fs.stat(filePath);
      // 删除超过1小时的文件
      if (now - stats.mtimeMs > 3600000) {
        try {
          if (stats.isDirectory()) {
            await fs.rm(filePath, { recursive: true, force: true });
          } else {
            await fs.unlink(filePath);
          }
          console.log(`Deleted old temporary file: ${file}`);
        } catch (e) {
          console.warn(`Failed to delete old temporary file: ${file}`, e?.message || e);
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up files:', error);
  }
};

// 定期清理旧文件（每30分钟）
setInterval(cleanupOldFiles, 1800000);

// 下载视频的API端点
// 查找工具的可执行文件路径
const findTool = async (toolName, possiblePaths = []) => {
  // 优先按指定路径顺序查找，确保优先使用 Homebrew 等较新环境
  for (const possiblePath of possiblePaths) {
    try {
      await execAsync(`test -x "${possiblePath}"`);
      return possiblePath;
    } catch {
      continue;
    }
  }

  // 其次回退到 PATH 中的可执行文件
  try {
    const { stdout } = await execAsync(`which ${toolName}`);
    return stdout.trim();
  } catch {
    return null;
  }
};

// 检查必要的工具是否已安装
const checkTools = async () => {
  // 优先使用系统/Homebrew 安装的 yt-dlp（你本机 Terminal.app 能跑通的那个）
  // 项目自带的 bin/yt-dlp 在某些机器上可能缺少 CA 证书链（会触发 curl: (77)）
  const ytDlpPath = await findTool('yt-dlp', [
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    `${process.env.HOME}/Library/Python/3.11/bin/yt-dlp`,
    `${process.env.HOME}/Library/Python/3.10/bin/yt-dlp`,
    `${process.env.HOME}/Library/Python/3.9/bin/yt-dlp`,
    path.join(__dirname, '../bin/yt-dlp'),
  ]);
  
  const ffmpegPath = await findTool('ffmpeg', [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    `${process.env.HOME}/bin/ffmpeg`,
    '/usr/bin/ffmpeg'
  ]);

  const missing = [];
  if (!ytDlpPath) missing.push('yt-dlp');
  if (!ffmpegPath) missing.push('ffmpeg');

  return { 
    ytDlp: !!ytDlpPath, 
    ffmpeg: !!ffmpegPath, 
    missing,
    ytDlpPath,
    ffmpegPath
  };
};

app.post('/api/video/from-url', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // 仅开放 YouTube 链接：其他网站不下载
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYouTube) {
    return res.status(400).json({ success: false, message: '仅支持Youtube视频链接' });
  }

  // 1. 检查缓存
  const videoId = getVideoId(url);
  if (videoId) {
    const videoCacheDir = path.join(cacheDir, videoId);
    try {
      await fs.mkdir(videoCacheDir, { recursive: true });
      const audioCachePath = path.join(videoCacheDir, 'audio.mp3');
      
      try {
        await fs.access(audioCachePath);
        console.log(`Using cached audio for video: ${videoId}`);
        return res.json({
          success: true,
          filename: `audio_${videoId}.mp3`,
          isCached: true,
          url: `/api/video/file/cache_${videoId}_audio.mp3`
        });
      } catch (e) {
        // 缓存不存在，继续下载
      }
    } catch (e) {
      console.warn('Failed to handle cache directory:', e);
    }
  }

  // 检查工具是否已安装
  const tools = await checkTools();
  if (tools.missing && tools.missing.length > 0) {
    const installInstructions = {
      'yt-dlp': 'macOS: brew install yt-dlp\nLinux: pip install yt-dlp\nWindows: pip install yt-dlp',
      'ffmpeg': 'macOS: brew install ffmpeg\nLinux: sudo apt-get install ffmpeg\nWindows: 从 https://ffmpeg.org/download.html 下载'
    };
    const instructions = tools.missing.map(tool => `${tool}:\n${installInstructions[tool] || '请查看 README.md'}`).join('\n\n');
    return res.status(500).json({
      success: false,
      error: 'Required tools not installed',
      message: `缺少必要的工具: ${tools.missing.join(', ')}\n\n安装说明:\n${instructions}`,
      missingTools: tools.missing
    });
  }

  try {
    // 生成唯一的文件名
    const timestamp = Date.now();
    const outputPath = path.join(downloadsDir, `audio_${timestamp}.%(ext)s`);

    console.log(`Downloading audio from: ${url}`);

    // 获取工具路径
    if (!tools.ytDlpPath) {
      throw new Error('yt-dlp not found. Please install it: pip3 install yt-dlp');
    }
    if (!tools.ffmpegPath) {
      throw new Error('ffmpeg not found. Please install it. See README.md for instructions.');
    }

    // 使用 yt-dlp 只下载音频流（仅 YouTube）
    // 使用完整路径调用 yt-dlp，并设置 PATH 以确保能找到 ffmpeg
    const env = { ...process.env };
    if (tools.ytDlpPath && !tools.ytDlpPath.startsWith('/usr')) {
      const ytDlpDir = path.dirname(tools.ytDlpPath);
      env.PATH = `${ytDlpDir}:${env.PATH}`;
    }
    if (tools.ffmpegPath && !tools.ffmpegPath.startsWith('/usr')) {
      const ffmpegDir = path.dirname(tools.ffmpegPath);
      env.PATH = `${ffmpegDir}:${env.PATH}`;
    }

    let command = `"${tools.ytDlpPath}" -f "bestaudio[ext=m4a]/bestaudio/best[ext=m4a]/best" --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --extractor-args "youtube:player_client=android" --user-agent "com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip" -o "${outputPath}" "${url}"`;

    console.log(`Executing: ${command}`);
    
    let stdout, stderr;
    try {
      const result = await execAsync(command, {
        timeout: 300000, // 5分钟超时
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        env: env
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      // YouTube：android 客户端失败时尝试其他客户端
      if (error.message && (error.message.includes('403') || error.message.includes('Forbidden'))) {
        console.log('Android client failed, trying web client...');
        const webCommand = `"${tools.ytDlpPath}" -f "bestaudio[ext=m4a]/bestaudio/best[ext=m4a]/best" --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --extractor-args "youtube:player_client=web" --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -o "${outputPath}" "${url}"`;
        try {
          const result = await execAsync(webCommand, {
            timeout: 300000,
            maxBuffer: 10 * 1024 * 1024,
            env: env
          });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (webError) {
          console.log('Web client failed, trying iOS client...');
          const iosCommand = `"${tools.ytDlpPath}" -f "bestaudio[ext=m4a]/bestaudio/best[ext=m4a]/best" --extract-audio --audio-format mp3 --audio-quality 0 --no-warnings --extractor-args "youtube:player_client=ios" --user-agent "com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)" -o "${outputPath}" "${url}"`;
          const result = await execAsync(iosCommand, {
            timeout: 300000,
            maxBuffer: 10 * 1024 * 1024,
            env: env
          });
          stdout = result.stdout;
          stderr = result.stderr;
        }
      } else {
        throw error;
      }
    }

    console.log('Download stdout:', stdout);
    if (stderr) console.log('Download stderr:', stderr);

    // 查找下载的文件
    const files = await fs.readdir(downloadsDir);
    const downloadedFile = files.find(f => f.startsWith(`audio_${timestamp}`));

    if (!downloadedFile) {
      throw new Error('Audio file not found after download');
    }

    const filePath = path.join(downloadsDir, downloadedFile);
    const stats = await fs.stat(filePath);

    // 检查文件大小
    if (stats.size > 100 * 1024 * 1024) {
      await fs.unlink(filePath);
      throw new Error('Audio file is too large (max 100MB)');
    }

    // 2. 如果有视频ID，保存到缓存
    if (videoId) {
      const videoCacheDir = path.join(cacheDir, videoId);
      const audioCachePath = path.join(videoCacheDir, 'audio.mp3');
      try {
        await fs.copyFile(filePath, audioCachePath);
        console.log(`Saved audio to cache for video: ${videoId}`);
      } catch (e) {
        console.warn('Failed to save audio to cache:', e);
      }
    }

    // 返回文件路径
    res.json({
      success: true,
      filename: downloadedFile,
      size: stats.size,
      url: `/api/video/file/${downloadedFile}`
    });

  } catch (error) {
    console.error('Error downloading audio:', error);
    const rawMsg = String(error?.message || error || '');
    const isPerm =
      /PermissionError|Operation not permitted|EPERM|EACCES/i.test(rawMsg) ||
      /Unsupported url scheme: \"https\" \(websockets\)/i.test(rawMsg);
    const isCa =
      /curl:\s*\(77\)\s*error setting certificate verify locations/i.test(rawMsg) ||
      /cacert\.pem/i.test(rawMsg);
    const shortMsg = isPerm
      ? '下载失败：yt-dlp 在当前后端运行环境里被系统拦截（Operation not permitted）。请用 Terminal.app 启动后端（npm run server），或更新/重装 yt-dlp 后重试。'
      : isCa
      ? '下载失败：yt-dlp 证书链不可用（CAfile/cacert.pem）。请使用系统安装的 yt-dlp（brew/pip），并用 Terminal.app 启动后端后重试。'
      : rawMsg;
    res.status(500).json({
      error: 'Failed to download audio',
      message: shortMsg
    });
  }
});

// 下载并缓存 720p 视频（用于预览练习页等场景）
app.post('/api/video/video-from-url', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, message: 'URL is required' });
  }

  // 仅开放 YouTube 链接
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYouTube) {
    return res.status(400).json({ success: false, message: '仅支持Youtube视频链接' });
  }

  const videoId = getVideoId(url);
  if (!videoId) {
    return res.status(400).json({ success: false, message: 'Invalid URL' });
  }

  const videoCacheDir = path.join(cacheDir, videoId);
  await fs.mkdir(videoCacheDir, { recursive: true });

  const cachedVideoPath = path.join(videoCacheDir, 'video.mp4');
  try {
    await fs.access(cachedVideoPath);
    const stats = await fs.stat(cachedVideoPath);
    return res.json({
      success: true,
      isCached: true,
      filename: `video_${videoId}.mp4`,
      size: stats.size,
      url: `/api/video/file/cache_${videoId}_video.mp4`,
    });
  } catch {
    // continue
  }

  // 检查工具是否已安装
  const tools = await checkTools();
  if (tools.missing && tools.missing.length > 0) {
    return res.status(500).json({
      success: false,
      message: `缺少必要的工具: ${tools.missing.join(', ')}`,
      missingTools: tools.missing,
    });
  }

  if (!tools.ytDlpPath || !tools.ffmpegPath) {
    return res.status(500).json({ success: false, message: 'Required tools not installed' });
  }

  try {
    // yt-dlp：选择 720p 以内的视频 + 音频并合并为 mp4
    const outputTemplate = path.join(videoCacheDir, 'video.%(ext)s');

    const env = { ...process.env };
    // 禁用代理，避免环境变量导致的网络问题
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
    delete env.ALL_PROXY;
    env.http_proxy = '';
    env.https_proxy = '';
    env.all_proxy = '';

    // 确保 PATH 里能找到 yt-dlp / ffmpeg
    const ytDlpDir = path.dirname(tools.ytDlpPath);
    const ffmpegDir = tools.ffmpegPath === 'ffmpeg' ? '' : path.dirname(tools.ffmpegPath);
    env.PATH = `${ytDlpDir}:${ffmpegDir ? `${ffmpegDir}:` : ''}${env.PATH}`;

    // 优先下载 H.264(avc1)+AAC(mp4a) 的 MP4，避免部分浏览器（尤其 Safari）无法播放 AV1(av01) 导致黑屏/0:00
    const format =
      'bv*[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a][acodec^=mp4a]/b[height<=720][ext=mp4][vcodec^=avc1]/best[height<=720]';
    const command = `"${tools.ytDlpPath}" --no-playlist --proxy \"\" -f \"${format}\" --merge-output-format mp4 -o \"${outputTemplate}\" \"${url}\"`;

    console.log(`[Video720] Downloading 720p video: ${url}`);
    const result = await execAsync(command, {
      timeout: 20 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
      env,
    });
    if (result.stderr && process.env.NODE_ENV === 'development') {
      console.log('[Video720] yt-dlp stderr:', result.stderr.substring(0, 800));
    }

    // 期望生成 video.mp4；如果没有则选最新的 video.* 文件
    let finalPath = cachedVideoPath;
    try {
      await fs.access(finalPath);
    } catch {
      const files = await fs.readdir(videoCacheDir);
      const candidates = files
        .filter((f) => f.startsWith('video.') && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm')))
        .map((f) => ({ f, p: path.join(videoCacheDir, f) }));
      if (candidates.length === 0) {
        throw new Error('视频下载失败：未生成输出文件');
      }
      // 若不是 mp4，尽量重命名为 video.mp4（某些格式下可能失败，直接回退）
      const chosen = candidates.find((c) => c.f.endsWith('.mp4')) || candidates[0];
      if (chosen.p !== finalPath) {
        try {
          await fs.rename(chosen.p, finalPath);
        } catch {
          finalPath = chosen.p;
        }
      }
    }

    const stats = await fs.stat(finalPath);
    return res.json({
      success: true,
      isCached: false,
      filename: `video_${videoId}.mp4`,
      size: stats.size,
      url: `/api/video/file/cache_${videoId}_video.mp4`,
    });
  } catch (e) {
    console.error('[Video720] download error:', e);
    return res.status(500).json({ success: false, message: '视频下载失败，请稍后重试' });
  }
});

// 提供下载文件的端点
app.get('/api/video/file/:filename', async (req, res) => {
  const { filename } = req.params;
  let filePath;

  // 处理缓存文件的特殊请求格式: cache_[videoId]_audio.mp3
  if (filename.startsWith('cache_')) {
    const parts = filename.split('_');
    if (parts.length >= 3) {
      const videoId = parts[1];
      const realFilename = parts.slice(2).join('_'); // audio.mp3
      filePath = path.join(cacheDir, videoId, realFilename === 'audio.mp3' ? 'audio.mp3' : realFilename);
    }
  } else {
    filePath = path.join(downloadsDir, filename);
  }

  if (!filePath) {
    return res.status(404).json({ error: 'Invalid filename format' });
  }

  try {
    await fs.access(filePath);
    // 根据文件扩展名设置Content-Type
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : 'video/mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

// Whisper 文件上传端点
app.post('/api/whisper/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // 生成唯一文件名
    const timestamp = Date.now();
    const ext = path.extname(req.file.originalname);
    const newFilename = `whisper_${timestamp}${ext}`;
    const newPath = path.join(downloadsDir, newFilename);

    // 重命名文件
    await fs.rename(req.file.path, newPath);

    res.json({
      success: true,
      filename: newFilename,
      size: req.file.size
    });
  } catch (error) {
    console.error('File upload error:', error);
    res.status(500).json({
      error: 'Failed to upload file',
      message: error.message
    });
  }
});

// Whisper 转录端点
app.post('/api/whisper/transcribe', async (req, res) => {
  const { filename, videoId: reqVideoId, localKey: reqLocalKey } = req.body;
  const localKey = String(reqLocalKey || '').trim();

  if (!filename && !localKey) {
    return res.status(400).json({ error: 'Filename or localKey is required' });
  }

  // 1. 尝试从请求或文件名中获取 videoId
  let videoId = reqVideoId;
  if (!videoId && filename && filename.startsWith('audio_')) {
    const match = filename.match(/audio_(BV[a-zA-Z0-9]+|[\w-]+)\.mp3/);
    if (match) videoId = match[1];
  }

  // 2. 检查字幕缓存（也做一次后处理，避免旧缓存显示成“一整段”）
  if (videoId) {
    const subtitleCachePath = path.join(cacheDir, videoId, 'subtitles.json');
    try {
      const cachedContent = await fs.readFile(subtitleCachePath, 'utf-8');
      const cachedSubtitles = JSON.parse(cachedContent);
      console.log(`Using cached subtitles for video: ${videoId}`);
      const normalized = postProcessSubtitles(Array.isArray(cachedSubtitles) ? cachedSubtitles : []);
      try {
        await fs.writeFile(subtitleCachePath, JSON.stringify(normalized, null, 2));
      } catch {}
      return res.json({
        success: true,
        subtitles: normalized,
        count: normalized.length,
        isCached: true
      });
    } catch (e) {
      // 缓存不存在，继续转录
    }
  }

  let filePath = null;
  if (localKey) {
    filePath = await findLocalVideoFile(localKey);
    if (!filePath) {
      return res.status(404).json({ error: 'Local video not found', message: '本地视频文件不存在' });
    }
  } else if (filename && filename.startsWith('cache_')) {
    filePath = path.join(cacheDir, videoId, 'audio.mp3');
  } else if (filename) {
    filePath = path.join(downloadsDir, filename);
  } else {
    return res.status(400).json({ error: 'Filename or localKey is required' });
  }
  
  try {
    // 检查文件是否存在
    await fs.access(filePath);
    
    console.log(`Transcribing audio file: ${localKey || filename}`);
    
    // 查找 whisper 命令
    // 优先使用用户已安装的 whisper，其次尝试桌面上的 whisper-main，最后尝试系统安装的 whisper
    let whisperCmd = null;
    let whisperPythonPath = null;
    
    // 首先尝试使用用户 Python 3.9 环境中的 whisper 命令
    const userWhisperPath = path.join(process.env.HOME, 'Library/Python/3.9/bin/whisper');
    try {
      await fs.access(userWhisperPath);
      whisperCmd = `"${userWhisperPath}"`;
      console.log(`Using user-installed whisper at: ${userWhisperPath}`);
    } catch {
      // 如果用户安装的 whisper 不存在，尝试使用 Python 3.9 的 python -m whisper
      try {
        const python39Path = '/usr/bin/python3.9';
        await execAsync(`test -x "${python39Path}" || which python3.9`);
        await execAsync(`${python39Path} -c "import whisper"`);
        whisperCmd = 'python3.9 -m whisper';
        console.log('Using: python3.9 -m whisper');
      } catch {
        // 尝试桌面上的 whisper-main
        const desktopWhisperPath = path.join(process.env.HOME, 'Desktop', 'whisper-main');
        try {
          await fs.access(desktopWhisperPath);
          await fs.access(path.join(desktopWhisperPath, 'whisper', '__init__.py'));
          whisperCmd = 'python3 -m whisper';
          whisperPythonPath = desktopWhisperPath;
          console.log(`Using desktop whisper-main at: ${desktopWhisperPath}`);
        } catch {
          // 尝试系统安装的 whisper
          try {
            await execAsync('python3 -c "import whisper"');
            whisperCmd = 'python3 -m whisper';
            console.log('Using: python3 -m whisper (system installed)');
          } catch {
            // 尝试直接使用 whisper 命令
            try {
              await execAsync('which whisper');
              whisperCmd = 'whisper';
              console.log('Using: whisper command');
            } catch {
              throw new Error('Whisper not found. Please install it with: pip3 install openai-whisper');
            }
          }
        }
      }
    }
    
    // 创建输出目录
    const outputDir = path.join(downloadsDir, 'whisper_output');
    await fs.mkdir(outputDir, { recursive: true });
    
    // 输出文件名（不带扩展名）
    // localKey 流程没有 filename，必须用实际落盘路径推导
    const sourceName = path.basename(filePath);
    const outputBase = path.basename(sourceName, path.extname(sourceName));
    const expectedOutputPath = path.join(outputDir, `${outputBase}.json`);
    let outputPath = expectedOutputPath;
    
    // 查找 ffmpeg 路径
    const findFfmpeg = async () => {
      const possiblePaths = [
        'ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/opt/homebrew/bin/ffmpeg',
        `${process.env.HOME}/bin/ffmpeg`,
        '/usr/bin/ffmpeg'
      ];
      
      for (const ffmpegPath of possiblePaths) {
        try {
          await execAsync(`which ${ffmpegPath === 'ffmpeg' ? 'ffmpeg' : `"${ffmpegPath}"`} || test -x "${ffmpegPath}"`);
          return ffmpegPath;
        } catch {
          continue;
        }
      }
      return null;
    };
    
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) {
      throw new Error('ffmpeg not found. Please install it: brew install ffmpeg');
    }
    
    // 设置环境变量，确保 Whisper 能找到 ffmpeg 和 whisper 模块
    const env = { ...process.env };
    if (ffmpegPath !== 'ffmpeg') {
      const ffmpegDir = path.dirname(ffmpegPath);
      env.PATH = `${ffmpegDir}:${env.PATH}`;
    }
    // 如果使用桌面上的 whisper-main，设置 PYTHONPATH
    if (whisperPythonPath) {
      env.PYTHONPATH = whisperPythonPath + (env.PYTHONPATH ? `:${env.PYTHONPATH}` : '');
      console.log(`PYTHONPATH set to: ${env.PYTHONPATH}`);
    }
    
    // 调用 whisper 进行转录
    // 使用 --output_format json 获取 JSON 格式输出
    // 使用 --output_dir 指定输出目录
    // 添加 --model base 使用较小的模型（更快），或使用 --model small/medium/large 获得更好质量
    // 不指定 --language 让 Whisper 自动检测语言
    // 默认模型升级到 small：对日语等非英语通常更准（代价是更慢）
    const command = `${whisperCmd} "${filePath}" --output_format json --output_dir "${outputDir}" --model small`;
    
    console.log(`Executing: ${command}`);
    console.log(`FFmpeg path: ${ffmpegPath}`);
    console.log(`File path: ${filePath}`);
    console.log(`Output path: ${outputPath}`);
    let stdout, stderr;
    try {
      const result = await execAsync(command, {
        timeout: 600000, // 10分钟超时
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        env: env, // 传递包含 ffmpeg 路径的环境变量
      });
      stdout = result.stdout;
      stderr = result.stderr;
      
      // 等待文件写入完成，最多等待 10 秒
      let fileFound = false;
      for (let i = 0; i < 20; i++) {
        try {
          await fs.access(outputPath);
          fileFound = true;
          console.log(`Found output file after ${i * 0.5}s: ${outputPath}`);
          break;
        } catch {
          // 也尝试查找目录中的所有 JSON 文件
          try {
            const files = await fs.readdir(outputDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));
            if (jsonFiles.length > 0) {
              // 使用最新的 JSON 文件（按修改时间排序）
              const jsonFilesWithStats = await Promise.all(
                jsonFiles.map(async (f) => {
                  const filePath = path.join(outputDir, f);
                  const stats = await fs.stat(filePath);
                  return { file: f, path: filePath, mtime: stats.mtimeMs };
                })
              );
              jsonFilesWithStats.sort((a, b) => b.mtime - a.mtime);
              outputPath = jsonFilesWithStats[0].path;
              console.log(`Found JSON file during wait (attempt ${i + 1}): ${outputPath}`);
              fileFound = true;
              break;
            }
          } catch (dirError) {
            // 继续等待
          }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      if (!fileFound) {
        // 最后尝试：列出目录内容以便调试
        try {
          const files = await fs.readdir(outputDir);
          console.error(`File not found after waiting. Output directory contents:`, files);
        } catch {
          console.error(`Cannot read output directory: ${outputDir}`);
        }
        // 不把超长 stderr 直接回传给前端（避免页面报错刷屏），详细信息仅记录在服务端日志
        const combined = `${stderr || ''}\n${stdout || ''}`;
        if (/Failed to load audio|Skipping .* due to RuntimeError/i.test(combined)) {
          throw new Error('转录失败：Whisper 无法读取音频，请换一个链接或稍后重试');
        }
        throw new Error('转录失败：Whisper 未生成输出文件，请稍后重试');
      }
    } catch (execError) {
      console.error('Whisper execution error:', execError);
      // 检查是否有部分输出
      if (execError.stdout) stdout = execError.stdout;
      if (execError.stderr) stderr = execError.stderr;
      
      // 即使命令失败，也尝试读取可能已生成的 JSON 文件
      try {
        const jsonContent = await fs.readFile(outputPath, 'utf-8');
        const whisperData = JSON.parse(jsonContent);
        if (whisperData.segments && whisperData.segments.length > 0) {
          console.log('Whisper command had errors but JSON file was generated, continuing...');
          // 继续处理，不抛出错误
        } else {
          const combined = `${stderr || ''}\n${stdout || ''}\n${execError?.message || ''}`;
          if (/Failed to load audio|Skipping .* due to RuntimeError/i.test(combined)) {
            throw new Error('转录失败：Whisper 无法读取音频，请换一个链接或稍后重试');
          }
          throw new Error('转录失败：Whisper 执行失败，请稍后重试');
        }
      } catch (readError) {
        const combined = `${stderr || ''}\n${stdout || ''}\n${execError?.message || ''}`;
        if (/Failed to load audio|Skipping .* due to RuntimeError/i.test(combined)) {
          throw new Error('转录失败：Whisper 无法读取音频，请换一个链接或稍后重试');
        }
        throw new Error('转录失败：Whisper 执行失败，请稍后重试');
      }
    }
    
    if (process.env.NODE_ENV === 'development') {
      if (stderr) console.log('Whisper stderr:', stderr);
      if (stdout) console.log('Whisper stdout:', stdout.substring(0, 500)); // 只打印前500字符
    }
    
    // 检查 JSON 文件是否存在
    // Whisper 可能使用不同的文件名，先检查预期路径，如果不存在则查找目录中的所有 JSON 文件
    let actualOutputPath = outputPath;
    try {
      await fs.access(outputPath);
    } catch {
      // 如果预期文件不存在，查找输出目录中的所有 JSON 文件
      console.log(`Expected output file not found: ${outputPath}, searching for JSON files in output directory...`);
      try {
        const files = await fs.readdir(outputDir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));
        if (jsonFiles.length > 0) {
          // 使用最新的 JSON 文件
          actualOutputPath = path.join(outputDir, jsonFiles[0]);
          console.log(`Found JSON file: ${actualOutputPath}`);
        } else {
          // 列出所有文件以便调试
          console.log(`No JSON files found. All files in output directory:`, files);
          throw new Error(`Whisper output file not found: ${outputPath}. Command may have failed. Check stdout/stderr for details.`);
        }
      } catch (dirError) {
        throw new Error(`Whisper output file not found: ${outputPath}. Directory read error: ${dirError.message}`);
      }
    }
    
    // 读取生成的 JSON 文件
    let jsonContent;
    try {
      jsonContent = await fs.readFile(actualOutputPath, 'utf-8');
    } catch (readError) {
      throw new Error(`Failed to read Whisper output file: ${readError.message}`);
    }
    
    let whisperData;
    try {
      whisperData = JSON.parse(jsonContent);
    } catch (parseError) {
      console.error('JSON parse error. File content:', jsonContent.substring(0, 500));
      throw new Error(`Failed to parse Whisper JSON output: ${parseError.message}`);
    }
    
    // 验证数据结构
    if (!whisperData || !Array.isArray(whisperData.segments)) {
      throw new Error(`Invalid Whisper output format. Expected segments array, got: ${JSON.stringify(Object.keys(whisperData || {}))}`);
    }
    
    // 转换 Whisper 格式到我们的 Subtitle 格式
    let rawSubtitles = whisperData.segments.map((segment, index) => ({
      id: index,
      startTime: segment.start,
      endTime: segment.end,
      text: segment.text.trim(),
    }));
    
    // 记录原始时间戳（用于调试）
    if (process.env.NODE_ENV === 'development') {
      console.log('Raw Whisper subtitles (first 5):', rawSubtitles.slice(0, 5).map(s => ({
        id: s.id,
        start: s.startTime.toFixed(2),
        end: s.endTime.toFixed(2),
        text: s.text.substring(0, 30) + '...',
        duration: (s.endTime - s.startTime).toFixed(2)
      })));
    }
    
    // 多语言断句 + 合并：避免日语/中文等被错误合并成一整段
    const mergedSubtitles = postProcessSubtitles(rawSubtitles);
    
    if (process.env.NODE_ENV === 'development') {
      console.log('Processed subtitles (first 5):', mergedSubtitles.slice(0, 5).map(s => ({
        id: s.id,
        start: s.startTime.toFixed(2),
        end: s.endTime.toFixed(2),
        text: s.text.substring(0, 30) + '...',
        duration: (s.endTime - s.startTime).toFixed(2)
      })));
    }
    
    // 验证和修复时间戳问题
    for (let i = 0; i < mergedSubtitles.length; i++) {
      const sub = mergedSubtitles[i];
      
      // 确保 startTime < endTime
      if (sub.startTime >= sub.endTime) {
        console.warn(`[Time Fix] Subtitle ${i} has invalid time range: ${sub.startTime.toFixed(2)}s - ${sub.endTime.toFixed(2)}s, fixing...`);
        // 如果时间戳无效，尝试从前一条或后一条推断
        if (i > 0) {
          const prev = mergedSubtitles[i - 1];
          sub.startTime = prev.endTime;
          sub.endTime = sub.startTime + 1.0; // 默认1秒
        } else if (i < mergedSubtitles.length - 1) {
          const next = mergedSubtitles[i + 1];
          sub.endTime = next.startTime;
          sub.startTime = Math.max(0, sub.endTime - 1.0); // 默认1秒
        }
      }
    }
    
    // 检查时间戳的连续性和重叠（用于调试）
    for (let i = 0; i < mergedSubtitles.length - 1; i++) {
      const current = mergedSubtitles[i];
      const next = mergedSubtitles[i + 1];
      const gap = next.startTime - current.endTime;
      
      if (gap > 1.0) {
        console.log(`[Time Gap] Subtitle ${i} ends at ${current.endTime.toFixed(2)}s, Subtitle ${i + 1} starts at ${next.startTime.toFixed(2)}s, Gap: ${gap.toFixed(2)}s`);
      }
      
      if (current.endTime > next.startTime) {
        console.warn(`[Time Overlap] Subtitle ${i} ends at ${current.endTime.toFixed(2)}s, Subtitle ${i + 1} starts at ${next.startTime.toFixed(2)}s, Overlap: ${(current.endTime - next.startTime).toFixed(2)}s`);
        // 修复重叠：将当前字幕的结束时间设置为下一条的开始时间
        current.endTime = next.startTime;
        console.log(`[Time Fix] Fixed overlap: Subtitle ${i} now ends at ${current.endTime.toFixed(2)}s`);
      }
    }
    
    // 重新分配 ID
    const subtitles = mergedSubtitles.map((sub, index) => ({
      ...sub,
      id: index
    }));
    
    // 清理临时文件
    try {
      await fs.unlink(actualOutputPath);
      // 也删除其他可能的输出文件（.txt, .vtt, .srt）
      const baseName = path.basename(actualOutputPath, '.json');
      const otherExts = ['.txt', '.vtt', '.srt'];
      for (const ext of otherExts) {
        try {
          await fs.unlink(path.join(outputDir, `${baseName}${ext}`));
        } catch {
          // 忽略删除失败
        }
      }
    } catch (error) {
      console.warn('Failed to cleanup whisper output files:', error);
    }
    
    console.log(`Generated ${subtitles.length} subtitles from Whisper`);
    
    // 3. 保存到缓存
    if (videoId) {
      const subtitleCachePath = path.join(cacheDir, videoId, 'subtitles.json');
      try {
        await fs.writeFile(subtitleCachePath, JSON.stringify(subtitles, null, 2));
        console.log(`Saved subtitles to cache for video: ${videoId}`);
      } catch (e) {
        console.warn('Failed to save subtitles to cache:', e);
      }
    }

    res.json({
      success: true,
      subtitles: subtitles,
      count: subtitles.length
    });
    
  } catch (error) {
    console.error('Whisper transcription error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: 'Failed to transcribe audio',
      message: error.message || 'Unknown error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// 多语言：句末标点 + 断句/合并策略
const SENTENCE_END_RE = /[.!?。！？｡．…]+$/;
const SOFT_JOIN_END_RE = /[,;–—-，、：:]+$/;
const CJK_LIKE_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/; // 日文假名/汉字/韩文

function isCjkLikeText(text) {
  return CJK_LIKE_RE.test(text || '');
}

function splitTextBySentencePunctuation(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  // 以句末标点拆分，保留标点在句子末尾
  const parts = t.match(/[^.!?。！？｡．…]+[.!?。！？｡．…]+|[^.!?。！？｡．…]+$/g);
  return (parts || []).map((s) => s.trim()).filter(Boolean);
}

// 把 Whisper 单个 segment 内的多句拆出来，避免“一条字幕里包含多句”
function explodeSubtitlesBySentences(subtitles) {
  const out = [];
  for (const sub of subtitles || []) {
    const start = Number(sub.startTime);
    const end = Number(sub.endTime);
    const text = String(sub.text || '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    if (end <= start) continue;

    const sentences = splitTextBySentencePunctuation(text);
    if (sentences.length <= 1) {
      out.push({ ...sub, text });
      continue;
    }

    const duration = end - start;
    const lengths = sentences.map((s) => Math.max(1, s.length));
    const total = lengths.reduce((a, b) => a + b, 0);
    let acc = 0;

    for (let i = 0; i < sentences.length; i++) {
      const prevAcc = acc;
      acc += lengths[i];
      const segStart = start + duration * (prevAcc / total);
      const segEnd = i === sentences.length - 1 ? end : start + duration * (acc / total);
      // 确保有最小持续时间，避免 start==end
      const safeEnd = Math.max(segEnd, segStart + 0.05);
      out.push({
        ...sub,
        startTime: segStart,
        endTime: safeEnd,
        text: sentences[i],
      });
    }
  }
  return out;
}

function postProcessSubtitles(subtitles) {
  const exploded = explodeSubtitlesBySentences(Array.isArray(subtitles) ? subtitles : []);
  const merged = mergeBrokenSentences(exploded);
  return merged;
}

// 智能合并断开的句子（多语言）
function mergeBrokenSentences(subtitles) {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return Array.isArray(subtitles) ? subtitles : [];

  const merged = [];
  let i = 0;

  // Whisper 在非英语/有停顿时经常把同一句切成多段，gap 会超过 0.6s。
  // 这里放宽阈值，优先保证“同一句不要被截断”。
  const maxGapToMerge = 1.5;
  const maxDurationToMerge = 30;
  const maxCharsCjk = 180;
  const maxCharsLatin = 280;

  const DEBUG_MERGE = process.env.NODE_ENV === 'development' && process.env.ECHOO_DEBUG_MERGE === '1';
  const mlog = (...args) => {
    if (DEBUG_MERGE) console.log(...args);
  };

  while (i < subtitles.length) {
    let current = { ...subtitles[i] };
    let j = i + 1;

    while (j < subtitles.length) {
      const currentText = String(current.text || '').trim();
      const nextText = String(subtitles[j].text || '').trim();
      if (!currentText || !nextText) break;

      const combinedText = currentText + nextText;
      const isCjk = isCjkLikeText(combinedText);
      const sentenceEnded = SENTENCE_END_RE.test(currentText);
      const nextStartsUpper = /^[A-Z]/.test(nextText);

      const gap = Number(subtitles[j].startTime) - Number(current.endTime);
      const nextEnd = Number(subtitles[j].endTime);

      const combinedDuration = nextEnd - Number(current.startTime);
      const maxChars = isCjk ? maxCharsCjk : maxCharsLatin;

      // 过大间隔 / 已结束 / 太长：都不再合并
      if (sentenceEnded) break;
      if (!Number.isFinite(gap) || gap > maxGapToMerge) break;
      if (combinedDuration > maxDurationToMerge) break;
      if ((currentText.length + 1 + nextText.length) > maxChars) break;

      // 多语言合并条件：
      const shouldMerge =
        // 句末还没结束：优先合并（特别适用于日语/中文无大写规则）
        (!sentenceEnded && gap <= maxGapToMerge) &&
        (
          // CJK：不用“大写开头”规则，主要靠句末标点与 gap 控制
          isCjk ||
          // Latin：保留大写启发式，但更偏向“不断句”，因此更宽松
          (!nextStartsUpper) ||
          (currentText.length < 25) ||
          SOFT_JOIN_END_RE.test(currentText) ||
          (nextText.length < 10 && !sentenceEnded)
        );

      if (!shouldMerge) break;

      // 合并：CJK 不加空格；拉丁语系加空格
      const joiner = isCjk ? '' : ' ';
      current.text = currentText + joiner + nextText;
      // 保持 startTime 为第一条开始时间，endTime 为最后一条结束时间
      current.endTime = nextEnd;

      mlog(`[Merge] ${i} + ${j} (gap=${gap.toFixed(2)}s, dur=${combinedDuration.toFixed(2)}s) -> "${current.text.slice(0, 60)}..."`);
      j++;
    }

    merged.push(current);
    i = j;
  }

  if (process.env.NODE_ENV === 'development') {
    console.log(`Merged ${subtitles.length} segments into ${merged.length} subtitles`);
  }
  return merged;
}

// 小牛翻译 API：用户可在「帮助 → API」中覆盖；未配置时用下方开发默认值
// TODO(发布前): 删掉 NIUTRANS_DEV_* 默认值，仅保留用户自填配置
const NIUTRANS_API_URL = 'https://api.niutrans.com/NiuTransServer/translation';
const NIUTRANS_SETTINGS_FILE = path.join(authDataDir, 'niutrans.json');
const NIUTRANS_DEV_API_KEY = '70c35f070dc2055ddcc9695377727a88';
const NIUTRANS_DEV_APPID = 'tE81765960293313';

const readNiutransSettings = async () => {
  try {
    const raw = await fs.readFile(NIUTRANS_SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);
    const apikey = typeof data?.apikey === 'string' ? data.apikey.trim() : '';
    const appid = typeof data?.appid === 'string' ? data.appid.trim() : '';
    if (apikey && appid) return { apikey, appid, source: 'file' };
  } catch {
    // ignore missing file
  }
  return {
    apikey: NIUTRANS_DEV_API_KEY,
    appid: NIUTRANS_DEV_APPID,
    source: 'dev-default',
  };
};

const writeNiutransSettings = async ({ apikey, appid }) => {
  const payload = {
    apikey: String(apikey || '').trim(),
    appid: String(appid || '').trim(),
    updatedAt: Date.now(),
  };
  await fs.mkdir(authDataDir, { recursive: true });
  await fs.writeFile(NIUTRANS_SETTINGS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
};

app.get('/api/settings/niutrans', async (_req, res) => {
  try {
    const settings = await readNiutransSettings();
    const fromFile = settings.source === 'file';
    res.json({
      success: true,
      // 有用户文件，或开发默认值，都算可用
      configured: Boolean(settings.apikey && settings.appid),
      usingDevDefault: !fromFile,
      // 仅回显用户已保存的配置；开发默认不填进表单，避免误以为已持久化
      apikey: fromFile ? settings.apikey : '',
      appid: fromFile ? settings.appid : '',
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Failed to read settings' });
  }
});

app.post('/api/settings/niutrans', async (req, res) => {
  try {
    const apikey = typeof req.body?.apikey === 'string' ? req.body.apikey.trim() : '';
    const appid = typeof req.body?.appid === 'string' ? req.body.appid.trim() : '';
    if (!apikey || !appid) {
      return res.status(400).json({ success: false, message: '请填写完整的 App ID 与 API Key' });
    }
    const saved = await writeNiutransSettings({ apikey, appid });
    res.json({ success: true, configured: true, apikey: saved.apikey, appid: saved.appid });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || 'Failed to save settings' });
  }
});

// 小牛翻译端点（通过后端代理，避免 CORS 问题）
app.post('/api/translate', async (req, res) => {
  try {
    const { text, from, to } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const settings = await readNiutransSettings();
    if (!settings.apikey || !settings.appid) {
      return res.status(400).json({
        success: false,
        error: 'Niutrans not configured',
        message: '请先在「帮助 → API」中填写小牛翻译的 App ID 与 API Key',
      });
    }

    const response = await fetch(NIUTRANS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from || 'en',
        to: to || 'zh',
        apikey: settings.apikey,
        appid: settings.appid,
        src_text: text,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Niutrans API error: ${response.status} - ${errorData.message || response.statusText}`);
    }

    const data = await response.json();
    
    // 检查小牛翻译的返回格式
    if (data.tgt_text) {
      res.json({
        success: true,
        translation: data.tgt_text
      });
    } else if (data.error_code) {
      // 小牛翻译返回错误码
      throw new Error(`Niutrans API error: ${data.error_code} - ${data.error_msg || 'Unknown error'}`);
    } else {
      console.error('Unexpected Niutrans API response:', JSON.stringify(data));
      throw new Error('Invalid response from Niutrans API: ' + JSON.stringify(data));
    }

  } catch (error) {
    console.error('Translation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to translate',
      message: error.message
    });
  }
});

// 缓存管理端点
// 检查视频缓存状态
app.get('/api/cache/status', async (req, res) => {
  const { url } = req.query;
  console.log(`[Cache] Status check for URL: ${url}`);
  const videoId = getVideoId(url);
  
  if (!videoId) {
    console.log(`[Cache] No videoId found for URL: ${url}`);
    return res.json({ success: true, cached: false });
  }

  const videoCacheDir = path.join(cacheDir, videoId);
  console.log(`[Cache] Checking directory: ${videoCacheDir}`);
  try {
    const files = await fs.readdir(videoCacheDir);
    console.log(`[Cache] Found files: ${files.join(', ')}`);
    const status = {
      audio: files.includes('audio.mp3'),
      video: files.includes('video.mp4'),
      subtitles: files.includes('subtitles.json'),
      translations: files.filter(f => f.startsWith('translation_')).map(f => f.replace('translation_', '').replace('.json', ''))
    };
    const isCached = status.audio || status.subtitles || status.video;
    console.log(`[Cache] Cache hit: ${isCached}`);
    res.json({
      success: true,
      videoId,
      cached: isCached,
      status
    });
  } catch (e) {
    console.log(`[Cache] Directory not found or error: ${e.message}`);
    res.json({ success: true, cached: false });
  }
});

// 保存/读取翻译缓存
app.post('/api/cache/translation', async (req, res) => {
  const { url, lang, subtitles } = req.body;
  const videoId = getVideoId(url);

  if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

  const translationPath = path.join(cacheDir, videoId, `translation_${lang}.json`);

  if (subtitles) {
    // 保存
    try {
      await fs.mkdir(path.dirname(translationPath), { recursive: true });
      await fs.writeFile(translationPath, JSON.stringify(subtitles, null, 2));
      return res.json({ success: true, message: 'Translation cached' });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to cache translation' });
    }
  } else {
    // 读取
    try {
      const content = await fs.readFile(translationPath, 'utf-8');
      return res.json({ success: true, subtitles: JSON.parse(content) });
    } catch (e) {
      return res.status(404).json({ error: 'Translation not found' });
    }
  }
});

// 删除缓存
app.delete('/api/cache', async (req, res) => {
  const { url } = req.body;
  const videoId = getVideoId(url);

  if (!videoId) return res.status(400).json({ error: 'Invalid URL' });

  const videoCacheDir = path.join(cacheDir, videoId);
  try {
    await fs.rm(videoCacheDir, { recursive: true, force: true });
    res.json({ success: true, message: 'Cache deleted' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete cache' });
  }
});

// 开源本地版：取消登录后默认开放语料库管理
const isAdmin = (_username) => true;

// 语料库：读取
const readCorpusDb = async () => {
  const db = await readJsonSafe(CORPUS_FILE, { items: {} });
  if (!db || typeof db !== 'object') return { items: {} };
  if (!db.items || typeof db.items !== 'object') db.items = {};
  return db;
};

// 语料库封面：取视频第 1 帧生成缩略图（首次请求时懒生成）
const corpusCoverPathForId = (videoId) => path.join(corpusVideosDir, `${videoId}.jpg`);

const findCorpusVideoFile = async (videoId) => {
  const files = await fs.readdir(corpusVideosDir);
  const videoFile = files.find((f) => f.startsWith(videoId) && !f.endsWith('.mp3') && !f.endsWith('.jpg') && !f.endsWith('.png') && !f.endsWith('.webp'));
  return videoFile ? path.join(corpusVideosDir, videoFile) : null;
};

const ensureCorpusCover = async (videoId) => {
  const coverPath = corpusCoverPathForId(videoId);
  try {
    await fs.access(coverPath);
    return coverPath;
  } catch {}

  const videoPath = await findCorpusVideoFile(videoId);
  if (!videoPath) return null;

  const ffmpegPath = await findTool('ffmpeg', [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    `${process.env.HOME}/bin/ffmpeg`,
    '/usr/bin/ffmpeg',
  ]);
  if (!ffmpegPath) return null;

  // 抽取第一帧；缩放到 640 宽以节省体积；用较高质量 jpg
  const cmd =
    `"${ffmpegPath}" -y -ss 0 -i "${videoPath}" -frames:v 1 -vf "scale=640:-2" -q:v 2 "${coverPath}"`;
  try {
    await execAsync(cmd, { timeout: 60000, maxBuffer: 1024 * 1024 });
    await fs.access(coverPath);
    return coverPath;
  } catch (e) {
    try { await fs.unlink(coverPath); } catch {}
    return null;
  }
};

// 语料库：列表（所有用户可访问）
app.get('/api/corpus', requireAuth, async (req, res) => {
  try {
    const db = await readCorpusDb();
    const items = Object.values(db.items || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // attach cache status and metadata
    const withStatus = await Promise.all(
      items.map(async (it) => {
        const lite = { ...it };
        // YouTube: 添加缩略图和时长
        if (lite.kind === 'youtube' || lite.platform === 'youtube') {
          if (!lite.thumbnailUrl) lite.thumbnailUrl = buildYoutubeThumbnailUrl(lite.videoId);
          if (lite.durationSec === undefined) {
            lite.durationSec = await getCachedDurationSecByVideoId(lite.videoId);
          }
        }
        // 语料库本地视频：提供封面 URL（封面接口会懒生成）
        if (lite.kind === 'local' || lite.platform === 'local') {
          lite.coverUrl = `/api/corpus/cover/${encodeURIComponent(lite.videoId)}`;
        }
        // expose custom title to frontend
        if (lite && lite.customTitle && !lite.title) {
          lite.title = lite.customTitle;
        }
        return { ...lite, cache: await buildFavoriteCacheSummary(it) };
      })
    );

    return res.json({ success: true, items: withStatus });
  } catch (e) {
    console.error('List corpus error:', e);
    return res.status(500).json({ success: false, message: '获取语料库失败' });
  }
});

// 语料库：更新（目前仅支持更新自定义标题；仅管理员）
app.patch('/api/corpus/:videoId', requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req.auth.username)) {
      return res.status(403).json({ success: false, message: '仅管理员可编辑语料库标题' });
    }

    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: '无效的参数' });

    const rawTitle = req.body?.customTitle;
    // 处理 customTitle：null/undefined -> null，空字符串 -> null，其他 -> trim后的字符串
    let customTitle = null;
    if (rawTitle !== null && rawTitle !== undefined) {
      const trimmed = String(rawTitle).trim();
      customTitle = trimmed.length > 0 ? trimmed : null;
    }

    if (customTitle !== null) {
      if (customTitle.length > 80) {
        return res.status(400).json({ success: false, message: '标题太长（最多80字）' });
      }
    }

    const updated = await withFavoritesLock(async () => {
      const db = await readCorpusDb();
      if (!db.items || !db.items[videoId]) return null;
      const it = db.items[videoId];
      if (customTitle === null) {
        delete it.customTitle;
      } else {
        it.customTitle = customTitle;
      }
      it.updatedAt = Date.now();
      db.items[videoId] = it;
      await writeJsonAtomic(CORPUS_FILE, db);
      return it;
    });

    if (!updated) return res.status(404).json({ success: false, message: '语料库项不存在' });
    const itemWithTitle = { ...updated };
    if (itemWithTitle.customTitle) {
      itemWithTitle.title = itemWithTitle.customTitle;
    }
    return res.json({ success: true, item: { ...itemWithTitle, cache: await buildFavoriteCacheSummary(updated) } });
  } catch (e) {
    console.error('[Update corpus title] Error:', e);
    return res.status(500).json({ success: false, message: '更新失败: ' + (e?.message || '未知错误') });
  }
});

// 语料库：封面图（公开访问）
app.get('/api/corpus/cover/:videoId', async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: '无效的视频ID' });

    // 只允许对存在于语料库 DB 的项生成/返回封面
    const db = await readCorpusDb();
    const it = db.items ? db.items[videoId] : null;
    if (!it) return res.status(404).json({ success: false, message: '语料库项不存在' });

    const coverPath = await ensureCorpusCover(videoId);
    if (!coverPath) return res.status(404).json({ success: false, message: '封面不存在' });

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(coverPath);
  } catch (e) {
    console.error('Get corpus cover error:', e);
    return res.status(500).json({ success: false, message: '获取封面失败' });
  }
});

// 语料库：添加（仅管理员）
app.post('/api/corpus', requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req.auth.username)) {
      return res.status(403).json({ success: false, message: '仅管理员可添加语料库内容' });
    }

    const now = Date.now();
    const kind = String(req.body?.kind || '').trim();

    // 1) Local video
    if (kind === 'local') {
      const localKey = String(req.body?.localKey || req.body?.videoId || '').trim();
      const meta = req.body?.meta || {};
      const subtitles = req.body?.subtitles;
      if (!localKey) return res.status(400).json({ success: false, message: '缺少本地视频标识' });
      if (!Array.isArray(subtitles) || subtitles.length === 0) {
        return res.status(400).json({ success: false, message: '缺少字幕数据' });
      }

      const item = {
        kind: 'local',
        videoId: localKey,
        url: `local://${localKey}`,
        platform: 'local',
        localMeta: {
          name: String(meta?.name || '').trim(),
          type: String(meta?.type || '').trim(),
          size: Number(meta?.size || 0),
          lastModified: Number(meta?.lastModified || 0),
        },
        subtitles,
        createdAt: now,
        updatedAt: now,
      };

      const saved = await withFavoritesLock(async () => {
        const db = await readCorpusDb();
        db.items[localKey] = item;
        await writeJsonAtomic(CORPUS_FILE, db);
        return item;
      });

      return res.json({ success: true, item: { ...saved, cache: await buildFavoriteCacheSummary(saved) } });
    }

    // 2) YouTube video
    const urlRaw = req.body?.url;
    const url = String(urlRaw || '').trim();
    if (!url) return res.status(400).json({ success: false, message: '请提供视频链接' });

    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    if (!isYouTube) return res.status(400).json({ success: false, message: '仅支持Youtube视频链接' });

    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: '无效的视频链接' });

    // 检查缓存状态
    const cacheStatus = await getCacheStatusByVideoId(videoId);
    const missing = [];
    if (!cacheStatus.audio) missing.push('audio');
    if (!cacheStatus.subtitles) missing.push('subtitles');
    if (!cacheStatus.translations?.includes('zh')) missing.push('translation_zh');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `缺少必要的缓存：${missing.join(', ')}。请先完成视频下载、转录和翻译。`,
        missing,
      });
    }

    const item = {
      kind: 'youtube',
      videoId,
      url: buildYoutubeWatchUrl(videoId),
      platform: 'youtube',
      createdAt: now,
      updatedAt: now,
    };

    const saved = await withFavoritesLock(async () => {
      const db = await readCorpusDb();
      db.items[videoId] = item;
      await writeJsonAtomic(CORPUS_FILE, db);
      return item;
    });

    return res.json({ success: true, item: { ...saved, cache: await buildFavoriteCacheSummary(saved) }, missing: [] });
  } catch (e) {
    console.error('Add corpus error:', e);
    return res.status(500).json({ success: false, message: '添加语料库失败' });
  }
});

// 语料库：上传视频（仅管理员）
app.post('/api/corpus/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!isAdmin(req.auth.username)) {
      return res.status(403).json({ success: false, message: '仅管理员可上传视频到语料库' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: '请选择视频文件' });
    }

    const now = Date.now();
    const fileHash = crypto.createHash('sha256').update(await fs.readFile(req.file.path)).digest('hex').substring(0, 16);
    const videoId = `corpus_${fileHash}_${now}`;
    const ext = path.extname(req.file.originalname);
    const finalFilename = `${videoId}${ext}`;
    const finalPath = path.join(corpusVideosDir, finalFilename);

    // 移动文件到永久存储目录
    await fs.rename(req.file.path, finalPath);

    // 提取音频用于转录
    const audioPath = path.join(corpusVideosDir, `${videoId}.mp3`);
    const tools = await checkTools();
    if (!tools.ffmpegPath) {
      await fs.unlink(finalPath);
      return res.status(500).json({ success: false, message: 'ffmpeg 未安装' });
    }

    try {
      await execAsync(
        `"${tools.ffmpegPath}" -i "${finalPath}" -vn -acodec libmp3lame -ab 192k -ar 44100 -y "${audioPath}"`,
        { timeout: 300000 }
      );
    } catch (e) {
      console.error('Audio extraction error:', e);
      await fs.unlink(finalPath);
      return res.status(500).json({ success: false, message: '音频提取失败' });
    }

    // 转录：直接调用转录逻辑（复用现有代码）
    let subtitles = [];
    try {
      // 将音频文件复制到 downloads 目录，以便转录 API 能找到
      const tempAudioFilename = `corpus_${videoId}.mp3`;
      const tempAudioPath = path.join(downloadsDir, tempAudioFilename);
      await fs.copyFile(audioPath, tempAudioPath);
      
      // 调用转录 API
      const transcribeResp = await fetch(`http://localhost:${PORT}/api/whisper/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: tempAudioFilename, videoId }),
      });
      const transcribeData = await transcribeResp.json();
      if (!transcribeResp.ok || !transcribeData.success) {
        throw new Error(transcribeData.error || '转录失败');
      }
      subtitles = transcribeData.subtitles || [];
      
      // 保存字幕到缓存
      const subtitleCachePath = path.join(cacheDir, videoId, 'subtitles.json');
      await fs.mkdir(path.dirname(subtitleCachePath), { recursive: true });
      await fs.writeFile(subtitleCachePath, JSON.stringify(subtitles, null, 2));
      
      // 清理临时文件
      await fs.unlink(tempAudioPath).catch(() => {});
    } catch (e) {
      console.error('Transcription error:', e);
      await fs.unlink(finalPath).catch(() => {});
      await fs.unlink(audioPath).catch(() => {});
      return res.status(500).json({ success: false, message: '转录失败: ' + (e?.message || '未知错误') });
    }

    // 翻译：逐句翻译并合并
    try {
      const translation = [];
      for (const sub of subtitles) {
        try {
          const translateResp = await fetch(`http://localhost:${PORT}/api/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: sub.text, from: 'en', to: 'zh' }),
          });
          const translateData = await translateResp.json();
          if (translateResp.ok && translateData.success) {
            translation.push({ translation: translateData.translation });
          } else {
            translation.push({ translation: '' });
          }
        } catch (e) {
          console.error('Translation error for subtitle:', e);
          translation.push({ translation: '' });
        }
      }
      
      const translationPath = path.join(cacheDir, videoId, 'translation_zh.json');
      await fs.writeFile(translationPath, JSON.stringify(translation, null, 2));
      
      // 合并翻译到字幕
      subtitles = subtitles.map((sub, idx) => ({
        ...sub,
        translation: translation[idx]?.translation || '',
      }));
    } catch (e) {
      console.error('Translation error:', e);
      // 翻译失败不影响保存，继续
    }

    // 保存到语料库
    const item = {
      kind: 'local',
      videoId,
      url: `corpus://${videoId}`,
      platform: 'local',
      localMeta: {
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size,
        lastModified: now,
      },
      subtitles,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await withFavoritesLock(async () => {
      const db = await readCorpusDb();
      db.items[videoId] = item;
      await writeJsonAtomic(CORPUS_FILE, db);
      return item;
    });

    return res.json({ success: true, item: { ...saved, cache: await buildFavoriteCacheSummary(saved) } });
  } catch (e) {
    console.error('Corpus upload error:', e);
    return res.status(500).json({ success: false, message: '上传失败: ' + (e?.message || '未知错误') });
  }
});

// 语料库：从 YouTube URL 添加（仅管理员）- 下载完整视频、转录、翻译
app.post('/api/corpus/add-from-youtube', requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req.auth.username)) {
      return res.status(403).json({ success: false, message: '仅管理员可添加语料库内容' });
    }

    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, message: '请提供视频链接' });

    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    if (!isYouTube) return res.status(400).json({ success: false, message: '仅支持Youtube视频链接' });

    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, message: '无效的视频链接' });

    console.log(`[Corpus] Starting YouTube import: ${videoId}`);

    // 1. 直接下载完整视频到语料库目录（720p MP4）
    console.log(`[Corpus] Step 1: Downloading video directly to corpus storage...`);
    const corpusVideoId = `corpus_${videoId}_${Date.now()}`;
    const corpusVideoPath = path.join(corpusVideosDir, `${corpusVideoId}.mp4`);
    let corpusVideoFinalPath = corpusVideoPath;
    
    // 检查工具是否已安装
    const tools = await checkTools();
    if (tools.missing && tools.missing.length > 0) {
      return res.status(500).json({
        success: false,
        message: `缺少必要的工具: ${tools.missing.join(', ')}`,
      });
    }

    if (!tools.ytDlpPath || !tools.ffmpegPath) {
      return res.status(500).json({ success: false, message: '缺少必要的工具: yt-dlp 或 ffmpeg' });
    }

    try {
      // 确保 corpus_videos 目录存在
      await fs.mkdir(corpusVideosDir, { recursive: true });

      // yt-dlp：选择 720p 以内的视频 + 音频并合并为 mp4
      const outputTemplate = path.join(corpusVideosDir, `${corpusVideoId}.%(ext)s`);

      const env = { ...process.env };
      // 禁用代理，避免环境变量导致的网络问题
      delete env.HTTP_PROXY;
      delete env.HTTPS_PROXY;
      delete env.ALL_PROXY;
      env.http_proxy = '';
      env.https_proxy = '';
      env.all_proxy = '';

      // 确保 PATH 里能找到 yt-dlp / ffmpeg
      const ytDlpDir = path.dirname(tools.ytDlpPath);
      const ffmpegDir = tools.ffmpegPath === 'ffmpeg' ? '' : path.dirname(tools.ffmpegPath);
      env.PATH = `${ytDlpDir}:${ffmpegDir ? `${ffmpegDir}:` : ''}${env.PATH}`;

      // 优先下载 H.264(avc1)+AAC(mp4a) 的 MP4，避免 AV1(av01) 在部分浏览器无法播放
      const format =
        'bv*[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a][acodec^=mp4a]/b[height<=720][ext=mp4][vcodec^=avc1]/best[height<=720]';
      const command = `"${tools.ytDlpPath}" --no-playlist --proxy "" -f "${format}" --merge-output-format mp4 -o "${outputTemplate}" "${url}"`;

      console.log(`[Corpus] Downloading video directly: ${url}`);
      console.log(`[Corpus] Command: ${command}`);
      let result;
      try {
        result = await execAsync(command, {
          timeout: 20 * 60 * 1000,
          maxBuffer: 50 * 1024 * 1024,
          env,
        });
      } catch (execErr) {
        console.error('[Corpus] yt-dlp execution error:', execErr);
        const errorMsg = execErr?.stderr || execErr?.message || '未知错误';
        // 压缩错误信息
        let shortMsg = '视频下载失败';
        if (errorMsg.includes('PermissionError') || errorMsg.includes('Operation not permitted')) {
          shortMsg = '视频下载失败：权限错误，请检查 yt-dlp 权限';
        } else if (errorMsg.includes('certificate') || errorMsg.includes('SSL')) {
          shortMsg = '视频下载失败：证书验证错误';
        } else if (errorMsg.includes('Unavailable') || errorMsg.includes('Private')) {
          shortMsg = '视频下载失败：视频不可用或为私有视频';
        } else if (errorMsg.length < 200) {
          shortMsg = `视频下载失败：${errorMsg}`;
        }
        throw new Error(shortMsg);
      }
      if (result.stderr && process.env.NODE_ENV === 'development') {
        console.log('[Corpus] yt-dlp stderr:', result.stderr.substring(0, 800));
      }

      // 期望生成 corpusVideoId.mp4；如果没有则选最新的匹配文件
      let finalPath = corpusVideoPath;
      try {
        await fs.access(finalPath);
      } catch {
        const files = await fs.readdir(corpusVideosDir);
        const candidates = files
          .filter((f) => f.startsWith(corpusVideoId) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm')))
          .map((f) => ({ f, p: path.join(corpusVideosDir, f) }));
        if (candidates.length === 0) {
          throw new Error('视频下载失败：未生成输出文件');
        }
        // 若不是 mp4，尽量重命名为 .mp4（某些格式下可能失败，直接回退）
        const chosen = candidates.find((c) => c.f.endsWith('.mp4')) || candidates[0];
        if (chosen.p !== finalPath) {
          try {
            await fs.rename(chosen.p, finalPath);
          } catch {
            finalPath = chosen.p;
          }
        }
      }

      corpusVideoFinalPath = finalPath;
      console.log(`[Corpus] Video downloaded directly to corpus storage: ${corpusVideoId}`);
    } catch (e) {
      console.error('[Corpus] Video download error:', e);
      return res.status(500).json({ success: false, message: '视频下载失败: ' + (e?.message || '未知错误') });
    }

    // 2. 下载音频（如果还没有）
    console.log(`[Corpus] Step 2: Ensuring audio exists...`);
    const audioCachePath = path.join(cacheDir, videoId, 'audio.mp3');
    try {
      await fs.access(audioCachePath);
      console.log(`[Corpus] Audio already cached`);
    } catch {
      // 音频不存在，下载音频
      // 注意：后端音频下载接口是 /api/video/from-url（不存在 audio-from-url）
      const audioResp = await fetch(`http://localhost:${PORT}/api/video/from-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const audioData = await audioResp.json();
      if (!audioResp.ok || !audioData.success) {
        return res.status(500).json({ success: false, message: '音频下载失败: ' + (audioData.message || '未知错误') });
      }
      console.log(`[Corpus] Audio downloaded`);
    }

    // 3. 转录
    console.log(`[Corpus] Step 3: Transcribing...`);
    const subtitleCachePath = path.join(cacheDir, videoId, 'subtitles.json');
    let subtitles = [];
    try {
      await fs.access(subtitleCachePath);
      const cachedContent = await fs.readFile(subtitleCachePath, 'utf-8');
      subtitles = JSON.parse(cachedContent);
      console.log(`[Corpus] Using cached subtitles`);
    } catch {
      // 字幕不存在，进行转录
      const transcribeResp = await fetch(`http://localhost:${PORT}/api/whisper/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: `cache_${videoId}_audio.mp3`, videoId }),
      });
      const transcribeData = await transcribeResp.json();
      if (!transcribeResp.ok || !transcribeData.success) {
        return res.status(500).json({ success: false, message: '转录失败: ' + (transcribeData.error || '未知错误') });
      }
      subtitles = transcribeData.subtitles || [];
      console.log(`[Corpus] Transcription completed: ${subtitles.length} segments`);
    }

    // 4. 翻译
    console.log(`[Corpus] Step 4: Translating...`);
    const translationPath = path.join(cacheDir, videoId, 'translation_zh.json');
    let translation = [];
    try {
      await fs.access(translationPath);
      const cachedTranslation = await fs.readFile(translationPath, 'utf-8');
      translation = JSON.parse(cachedTranslation);
      console.log(`[Corpus] Using cached translation`);
    } catch {
      // 翻译不存在，进行翻译
      translation = [];
      for (const sub of subtitles) {
        try {
          const translateResp = await fetch(`http://localhost:${PORT}/api/translate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: sub.text, from: 'en', to: 'zh' }),
          });
          const translateData = await translateResp.json();
          if (translateResp.ok && translateData.success) {
            translation.push({ translation: translateData.translation });
          } else {
            translation.push({ translation: '' });
          }
        } catch (e) {
          console.error('Translation error for subtitle:', e);
          translation.push({ translation: '' });
        }
      }
      await fs.writeFile(translationPath, JSON.stringify(translation, null, 2));
      console.log(`[Corpus] Translation completed`);
    }

    // 合并翻译到字幕
    subtitles = subtitles.map((sub, idx) => ({
      ...sub,
      translation: translation[idx]?.translation || '',
    }));

    // 5. 保存到语料库
    console.log(`[Corpus] Step 6: Saving to corpus...`);
    const now = Date.now();
    const videoStats = await fs.stat(corpusVideoFinalPath);
    const item = {
      kind: 'local',
      videoId: corpusVideoId,
      originalVideoId: videoId,
      originalUrl: buildYoutubeWatchUrl(videoId),
      url: `corpus://${corpusVideoId}`,
      platform: 'local',
      localMeta: {
        name: `YouTube: ${videoId}`,
        type: 'video/mp4',
        size: videoStats.size,
        lastModified: now,
      },
      subtitles,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await withFavoritesLock(async () => {
      const db = await readCorpusDb();
      db.items[corpusVideoId] = item;
      await writeJsonAtomic(CORPUS_FILE, db);
      return item;
    });

    console.log(`[Corpus] Successfully added to corpus: ${corpusVideoId}`);
    return res.json({ success: true, item: { ...saved, cache: await buildFavoriteCacheSummary(saved) } });
  } catch (e) {
    console.error('[Corpus] Add from YouTube error:', e);
    return res.status(500).json({ success: false, message: '添加失败: ' + (e?.message || '未知错误') });
  }
});

// 语料库：删除（仅管理员）
app.delete('/api/corpus/:videoId', requireAuth, async (req, res) => {
  try {
    if (!isAdmin(req.auth.username)) {
      return res.status(403).json({ success: false, message: '仅管理员可删除语料库内容' });
    }

    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: '无效的参数' });

    const deleted = await withFavoritesLock(async () => {
      const db = await readCorpusDb();
      if (!db.items || !db.items[videoId]) return false;
      delete db.items[videoId];
      await writeJsonAtomic(CORPUS_FILE, db);
      return true;
    });

    if (!deleted) return res.status(404).json({ success: false, message: '语料库项不存在' });
    return res.json({ success: true });
  } catch (e) {
    console.error('Delete corpus error:', e);
    return res.status(500).json({ success: false, message: '删除失败' });
  }
});

// 语料库：详情（用于获取字幕等完整信息）
app.get('/api/corpus/:videoId', requireAuth, async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) return res.status(400).json({ success: false, message: '无效的参数' });
    const db = await readCorpusDb();
    const it = db.items ? db.items[videoId] : null;
    if (!it) return res.status(404).json({ success: false, message: '语料库项不存在' });
    const out = { ...it };
    if (out.customTitle) out.title = out.customTitle;
    if (out.kind === 'local' || out.platform === 'local') {
      out.coverUrl = `/api/corpus/cover/${encodeURIComponent(out.videoId)}`;
    }
    return res.json({ success: true, item: { ...out, cache: await buildFavoriteCacheSummary(it) } });
  } catch (e) {
    console.error('Get corpus error:', e);
    return res.status(500).json({ success: false, message: '获取语料库项失败' });
  }
});

// 语料库：视频文件访问（所有用户可访问）
// 语料库视频文件：公开访问（与预览页下载后的视频一致，便于 <video> 直接拉流）
app.get('/api/corpus/file/:videoId', async (req, res) => {
  try {
    const videoId = String(req.params.videoId || '').trim();
    if (!videoId) {
      return res.status(400).json({ success: false, message: '无效的视频ID' });
    }
    
    const db = await readCorpusDb();
    const it = db.items ? db.items[videoId] : null;
    if (!it) return res.status(404).json({ success: false, message: '语料库项不存在' });
    
    // 查找视频文件（支持 corpus_ 开头的 ID）
    const files = await fs.readdir(corpusVideosDir);
    // 优先 mp4；避免误命中封面 jpg/png/webp
    const videoFile =
      files.find((f) => f.startsWith(videoId) && f.endsWith('.mp4')) ||
      files.find(
        (f) =>
          f.startsWith(videoId) &&
          !f.endsWith('.mp3') &&
          !f.endsWith('.jpg') &&
          !f.endsWith('.jpeg') &&
          !f.endsWith('.png') &&
          !f.endsWith('.webp')
      );
    if (!videoFile) {
      return res.status(404).json({ success: false, message: '视频文件不存在' });
    }
    
    const videoPath = path.join(corpusVideosDir, videoFile);
    const stats = await fs.stat(videoPath);

    const contentType = it.localMeta?.type || 'video/mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    // 支持 Range：浏览器播放/拖动进度条通常依赖 206 Partial Content
    const range = req.headers.range;
    if (range) {
      const m = String(range).match(/bytes=(\d*)-(\d*)/);
      if (!m) {
        return res.status(416).end();
      }
      const startRaw = m[1];
      const endRaw = m[2];
      const start = startRaw ? Number.parseInt(startRaw, 10) : 0;
      const end = endRaw ? Number.parseInt(endRaw, 10) : stats.size - 1;

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stats.size) {
        res.setHeader('Content-Range', `bytes */${stats.size}`);
        return res.status(416).end();
      }

      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
      res.setHeader('Content-Length', chunkSize);
      const fileStream = fsSync.createReadStream(videoPath, { start, end });
      fileStream.pipe(res);
      return;
    }

    res.setHeader('Content-Length', stats.size);
    const fileStream = fsSync.createReadStream(videoPath);
    fileStream.pipe(res);
  } catch (e) {
    console.error('Get corpus file error:', e);
    return res.status(500).json({ success: false, message: '获取视频文件失败' });
  }
});

// 健康检查端点
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on http://0.0.0.0:${PORT}`);
  console.log(`Backend server accessible at http://localhost:${PORT}`);
  console.log('Make sure yt-dlp is installed: pip install yt-dlp');
  console.log('Make sure whisper is installed: pip install openai-whisper');
});

