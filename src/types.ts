export interface Subtitle {
  id: number;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  text: string;
  translation?: string; // Optional translation text
}

export interface VideoState {
  url: string | null;
  file: File | null;
  duration: number;
  isPlaying: boolean;
}

export enum ProcessStatus {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}