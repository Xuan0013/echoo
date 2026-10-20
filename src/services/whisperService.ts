import { Subtitle } from "../types";
import { API_BASE_URL } from './config';

/**
 * 使用本地 Whisper 模型生成字幕
 * 通过后端服务调用本地安装的 Whisper
 */
export const generateSubtitlesWithWhisper = async (file: File): Promise<Subtitle[]> => {
  try {
    // 1. 先将文件上传到后端
    console.log("Uploading file to backend for Whisper processing...");
    const formData = new FormData();
    formData.append("file", file);
    
    const uploadResponse = await fetch(`${API_BASE_URL}/api/whisper/upload`, {
      method: "POST",
      body: formData,
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json().catch(() => ({ error: { message: uploadResponse.statusText } }));
      throw new Error(errorData.error?.message || `Upload failed: ${uploadResponse.statusText}`);
    }

    const uploadData = await uploadResponse.json();
    const filename = uploadData.filename;
    
    console.log(`File uploaded: ${filename}, starting transcription...`);

    // 2. 调用后端 Whisper 转录服务
    const transcribeResponse = await fetch(`${API_BASE_URL}/api/whisper/transcribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filename }),
    });

    if (!transcribeResponse.ok) {
      let errorData;
      try {
        errorData = await transcribeResponse.json();
      } catch {
        errorData = { error: { message: transcribeResponse.statusText } };
      }
      const errorMessage = errorData.error?.message || errorData.message || `Transcription failed: ${transcribeResponse.statusText}`;
      console.error('Transcription API error:', errorData);
      throw new Error(errorMessage);
    }

    const transcribeData = await transcribeResponse.json();
    
    if (!transcribeData.success || !transcribeData.subtitles) {
      throw new Error(transcribeData.error || "Invalid response from Whisper service");
    }

    const subtitles: Subtitle[] = transcribeData.subtitles;

    console.log(`Generated ${subtitles.length} subtitles from local Whisper`);
    console.log("Time range:", {
      first: subtitles[0]?.startTime.toFixed(2),
      last: subtitles[subtitles.length - 1]?.endTime.toFixed(2),
    });

    return subtitles;

  } catch (error: any) {
    console.error("Whisper Transcription Error:", error);
    throw new Error(error.message || "Failed to generate subtitles with Whisper");
  }
};

/**
 * 使用已落盘的本地视频（local_videos/<localKey>.*）转录，避免二次上传
 */
export const generateSubtitlesWithWhisperFromLocalKey = async (localKey: string): Promise<Subtitle[]> => {
  const transcribeResponse = await fetch(`${API_BASE_URL}/api/whisper/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ localKey }),
  });

  if (!transcribeResponse.ok) {
    let errorData;
    try {
      errorData = await transcribeResponse.json();
    } catch {
      errorData = { error: { message: transcribeResponse.statusText } };
    }
    const errorMessage =
      errorData.error?.message || errorData.message || `Transcription failed: ${transcribeResponse.statusText}`;
    throw new Error(errorMessage);
  }

  const transcribeData = await transcribeResponse.json();
  if (!transcribeData.success || !transcribeData.subtitles) {
    throw new Error(transcribeData.error || 'Invalid response from Whisper service');
  }
  return transcribeData.subtitles as Subtitle[];
};

/**
 * 使用缓存音频（cache/<videoId>/audio.mp3）转录（不需要重新上传音频）
 */
export const generateSubtitlesWithWhisperFromCache = async (videoId: string): Promise<Subtitle[]> => {
  const filename = `cache_${videoId}_audio.mp3`;
  const transcribeResponse = await fetch(`${API_BASE_URL}/api/whisper/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filename, videoId }),
  });

  if (!transcribeResponse.ok) {
    let errorData;
    try {
      errorData = await transcribeResponse.json();
    } catch {
      errorData = { error: { message: transcribeResponse.statusText } };
    }
    const errorMessage = errorData.error?.message || errorData.message || `Transcription failed: ${transcribeResponse.statusText}`;
    throw new Error(errorMessage);
  }

  const transcribeData = await transcribeResponse.json();
  if (!transcribeData.success || !transcribeData.subtitles) {
    throw new Error(transcribeData.error || "Invalid response from Whisper service");
  }
  return transcribeData.subtitles as Subtitle[];
};

