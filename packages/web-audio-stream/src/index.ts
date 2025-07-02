// web-audio-stream - iOS Safari-safe Web Audio streaming
// Fixes pitch/speed issues and prevents page reloads on iOS Safari

import { WebAudioManager, getWebAudioManager } from './WebAudioManager.js';

export { WebAudioManager, getWebAudioManager } from './WebAudioManager.js';
export type { WebAudioManagerOptions } from './WebAudioManager.js';

export { AudioChunkStore } from './AudioChunkStore.js';
export type { 
  AudioMetadata, 
  AudioChunk, 
  StoredChunk, 
  ProgressCallback 
} from './AudioChunkStore.js';

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
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
} = {}): Promise<WebAudioManager> {
  const manager = getWebAudioManager(options);
  await manager.initialize();
  return manager;
}

// Re-export for convenience
export { WebAudioManager as default };