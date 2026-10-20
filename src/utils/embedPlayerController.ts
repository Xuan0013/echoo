// Embed 播放器控制器
// 用于控制 YouTube embed 播放器

export interface EmbedPlayerController {
  seekTo: (seconds: number) => Promise<void>;
  play: () => void;
  pause: () => void;
  setPlaybackRate: (rate: number) => void;
  getCurrentTime: () => Promise<number>;
  getDuration: () => Promise<number>;
  isPlaying: () => Promise<boolean>;
}

// YouTube IFrame API 控制器
export class YouTubeController implements EmbedPlayerController {
  private player: any = null;
  private isReady: boolean = false;
  private videoId: string;

  constructor(videoId: string, onReady?: () => void) {
    this.videoId = videoId;
    this.initializePlayer(onReady);
  }

  private initializePlayer(onReady?: () => void) {
    console.log('YouTubeController: Initializing player for video:', this.videoId);
    if (typeof window === 'undefined' || !(window as any).YT) {
      console.log('YouTube IFrame API not loaded, loading now...');
      this.loadYouTubeAPI().then(() => {
        console.log('YouTube IFrame API loaded, creating player...');
        this.createPlayer(onReady);
      }).catch((error) => {
        console.error('Failed to load YouTube IFrame API:', error);
      });
    } else {
      console.log('YouTube IFrame API already loaded, creating player...');
      this.createPlayer(onReady);
    }
  }

  private loadYouTubeAPI(): Promise<void> {
    return new Promise((resolve) => {
      if ((window as any).YT && (window as any).YT.Player) {
        resolve();
        return;
      }

      const existingCallback = (window as any).onYouTubeIframeAPIReady;
      
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

      (window as any).onYouTubeIframeAPIReady = () => {
        if (existingCallback) {
          existingCallback();
        }
        resolve();
      };
    });
  }

  private createPlayer(onReady?: () => void) {
    const YT = (window as any).YT;
    if (!YT) {
      console.log('YT not available, retrying in 100ms...');
      setTimeout(() => this.createPlayer(onReady), 100);
      return;
    }

    const container = document.getElementById(`youtube-player-${this.videoId}`);
    if (!container) {
      console.log(`Container youtube-player-${this.videoId} not found, retrying in 100ms...`);
      setTimeout(() => this.createPlayer(onReady), 100);
      return;
    }

    console.log('Creating YouTube player instance...');
    try {
      this.player = new YT.Player(`youtube-player-${this.videoId}`, {
        videoId: this.videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: any) => {
            console.log('YouTube player onReady event fired');
            this.isReady = true;
            if (onReady) onReady();
          },
          onStateChange: (event: any) => {
            console.log('YouTube player state changed:', event.data);
          },
          onError: (event: any) => {
            console.error('YouTube player error:', event.data);
          },
        },
      });
      console.log('YouTube player instance created');
    } catch (error) {
      console.error('Error creating YouTube player:', error);
    }
  }

  async seekTo(seconds: number): Promise<void> {
    console.log('YouTubeController.seekTo called:', seconds, 'isReady:', this.isReady, 'player:', !!this.player);
    if (this.isReady && this.player) {
      try {
        this.player.seekTo(seconds, true);
        console.log('Seek command sent to YouTube player');
      } catch (error) {
        console.error('Error seeking YouTube player:', error);
      }
    } else {
      console.warn('YouTube player not ready, cannot seek');
    }
  }

  play(): void {
    if (this.isReady && this.player) {
      this.player.playVideo();
    }
  }

  pause(): void {
    if (this.isReady && this.player) {
      this.player.pauseVideo();
    }
  }

  setPlaybackRate(rate: number): void {
    if (this.isReady && this.player) {
      this.player.setPlaybackRate(rate);
    }
  }

  async getCurrentTime(): Promise<number> {
    if (this.isReady && this.player) {
      try {
        const time = this.player.getCurrentTime();
        return typeof time === 'number' && !isNaN(time) ? time : 0;
      } catch (error) {
        console.error('Error getting current time from YouTube player:', error);
        return 0;
      }
    }
    return 0;
  }

  async getDuration(): Promise<number> {
    if (this.isReady && this.player) {
      return this.player.getDuration();
    }
    return 0;
  }

  async isPlaying(): Promise<boolean> {
    if (this.isReady && this.player) {
      const state = this.player.getPlayerState();
      return state === (window as any).YT.PlayerState.PLAYING;
    }
    return false;
  }

  destroy(): void {
    if (this.player) {
      this.player.destroy();
      this.player = null;
      this.isReady = false;
    }
  }
}
