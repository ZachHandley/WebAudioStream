// web-audio-stream - iOS Safari-safe Web Audio streaming
// Fixes pitch/speed issues and prevents page reloads on iOS Safari

import { WebAudioManager, getWebAudioManager, type InstantPlaybackConfig } from './WebAudioManager.js';

export { WebAudioManager, getWebAudioManager } from './WebAudioManager.js';
export type { 
  WebAudioManagerOptions, 
  InstantPlaybackConfig 
} from './WebAudioManager.js';

export { AudioChunkStore } from './AudioChunkStore.js';
export type { 
  AudioMetadata, 
  AudioChunk, 
  StoredChunk, 
  ProgressCallback
} from './AudioChunkStore.js';

export { DownloadManager } from './DownloadManager.js';
export type {
  DownloadChunk,
  DownloadProgress,
  DownloadStrategy,
  DownloadManagerOptions
} from './DownloadManager.js';

export { StreamingAssembler } from './StreamingAssembler.js';
export type {
  AssemblyChunk,
  StreamingAssemblerOptions
} from './StreamingAssembler.js';

// Utility functions for iOS Safari detection
export function isIOSSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  
  const userAgent = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(userAgent);
  const isSafari = /Safari/.test(userAgent) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(userAgent);
  
  return isIOS && isSafari;
}

// Quick setup function for basic usage
export async function setupWebAudio(options: {
  workletPath?: string;
  enableCache?: boolean;
  enableInstantPlayback?: boolean;
  instantPlaybackConfig?: InstantPlaybackConfig;
  obfuscationKey?: string;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
} = {}): Promise<WebAudioManager> {
  const manager = getWebAudioManager(options);
  await manager.initialize();
  return manager;
}

// Quick setup function optimized for instant playback with separated download/storage
export async function setupInstantAudio(options: {
  workletPath?: string;
  enableCache?: boolean;
  downloadChunkSize?: number;      // Size for network downloads (256KB-512KB)
  storageChunkSize?: number;       // Size for IndexedDB storage (1-3MB)
  playbackChunkSize?: number;      // Size for initial playback (256KB-384KB)
  maxInitialWaitTime?: number;
  enablePerformanceLogging?: boolean;
  obfuscationKey?: string;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
  onProgressiveLoadingStatus?: (status: 'STARTED' | 'PROGRESS' | 'COMPLETED' | 'FAILED', data?: any) => void;
} = {}): Promise<WebAudioManager> {
  const instantConfig: InstantPlaybackConfig = {
    downloadStrategy: {
      initialChunkSize: options.downloadChunkSize || 256 * 1024,    // 256KB downloads
      standardChunkSize: options.downloadChunkSize || 512 * 1024,   // 512KB subsequent downloads
      maxConcurrentDownloads: 4,
      priorityFirstChunk: true,
      adaptiveChunkSizing: true
    },
    storageChunkSize: options.storageChunkSize || 2 * 1024 * 1024,  // 2MB storage chunks
    playbackChunkSize: options.playbackChunkSize || 384 * 1024,     // 384KB playback chunk
    maxInitialWaitTime: options.maxInitialWaitTime || 500,
    strategy: 'always',
    enablePerformanceLogging: options.enablePerformanceLogging || false
  };
  
  const manager = getWebAudioManager({
    workletPath: options.workletPath,
    enableCache: options.enableCache,
    enableInstantPlayback: true,
    instantPlaybackConfig: instantConfig,
    obfuscationKey: options.obfuscationKey,
    onTimeUpdate: options.onTimeUpdate,
    onEnded: options.onEnded,
    onError: options.onError,
    onProgressiveLoadingStatus: options.onProgressiveLoadingStatus
  });
  
  await manager.initialize();
  return manager;
}

// Re-export for convenience
export { WebAudioManager as default };