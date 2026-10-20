import { Subtitle } from '../types';
import { API_BASE_URL } from './config';

// 小牛翻译语言代码映射
const getLanguageCode = (language: string): string => {
  const langMap: Record<string, string> = {
    'Chinese (Simplified)': 'zh',
    'Chinese (Traditional)': 'cht',
    Chinese: 'zh',
    zh: 'zh',
    'zh-CN': 'zh',
    'zh-TW': 'cht',
    English: 'en',
    en: 'en',
    Japanese: 'ja',
    ja: 'ja',
    Korean: 'ko',
    ko: 'ko',
    Spanish: 'es',
    es: 'es',
    French: 'fr',
    fr: 'fr',
    German: 'de',
    de: 'de',
    Italian: 'it',
    it: 'it',
    Portuguese: 'pt',
    pt: 'pt',
    Russian: 'ru',
    ru: 'ru',
    Arabic: 'ar',
    ar: 'ar',
    Thai: 'th',
    th: 'th',
    Vietnamese: 'vi',
    vi: 'vi',
    Hindi: 'hi',
    hi: 'hi',
    Indonesian: 'id',
    id: 'id',
    Dutch: 'nl',
    nl: 'nl',
    Polish: 'pl',
    pl: 'pl',
    Turkish: 'tr',
    tr: 'tr',
  };
  return langMap[language] || 'zh';
};

// 基于文本的简单源语言检测（非模型）
const detectSourceLanguage = (text: string): string => {
  if (!text || text.trim().length === 0) return 'en';
  if (/[\u4e00-\u9fa5]/.test(text)) return 'zh';
  if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7a3]/.test(text)) return 'ko';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
  return 'en';
};

const translateText = async (text: string, from: string = 'en', to: string = 'zh'): Promise<string> => {
  const response = await fetch(`${API_BASE_URL}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, from, to }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Translation API error: ${response.status} - ${errorData.message || response.statusText}`);
  }

  const data = await response.json();
  if (data.success && data.translation) return data.translation;
  throw new Error('Invalid response from translation API');
};

const translateTextWithRetry = async (
  text: string,
  from: string,
  to: string,
  maxRetries: number = 3,
  retryDelay: number = 1000
): Promise<string> => {
  let lastError: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await translateText(text, from, to);
    } catch (error: any) {
      lastError = error;
      console.warn(`Translation attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
      }
    }
  }
  throw lastError;
};

export const translateSubtitles = async (
  subtitles: Subtitle[],
  targetLanguage: string,
  onProgress?: (done: number, total: number) => void
): Promise<Subtitle[]> => {
  const targetLangCode = getLanguageCode(targetLanguage);
  const sampleText = subtitles.length > 0 ? subtitles[0].text : '';
  const sourceLangCode = detectSourceLanguage(sampleText);

  console.log(`Translating ${subtitles.length} subtitles using Niutrans API...`);
  console.log(`Detected source language: ${sourceLangCode}, Target language: ${targetLangCode}`);

  const total = subtitles.length;
  const translatedSubtitles: Subtitle[] = [];
  for (let index = 0; index < subtitles.length; index++) {
    const sub = subtitles[index];
    try {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const translation = await translateTextWithRetry(sub.text, sourceLangCode, targetLangCode, 3, 1000);
      translatedSubtitles.push({ ...sub, translation });
    } catch (error: any) {
      console.error(`Failed to translate subtitle ${index + 1} after retries:`, error);
      translatedSubtitles.push({ ...sub, translation: '' });
    }
    onProgress?.(index + 1, total);
  }

  return translatedSubtitles;
};
