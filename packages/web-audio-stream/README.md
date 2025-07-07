# web-audio-stream

iOS Safari-safe Web Audio streaming with **separated download/storage optimization**, instant playback and memory management.

## ✨ Features

- **🚀 Instant Playback**: Start playing within 100-500ms using separated download strategy
- **📡 Download Optimization**: Network-optimized chunks (64KB-512KB) separate from storage chunks (1-3MB)
- **🔄 Streaming Assembly**: Real-time chunk assembly for seamless playback transitions
- **🍎 iOS Safari Compatibility**: Fixes pitch/speed issues and prevents page reloads
- **⚡ Progressive Loading**: Background streaming with seamless buffer replacement
- **🎯 Range Request Support**: Parallel downloads with configurable concurrency
- **💾 Smart Caching**: IndexedDB storage with automatic cleanup
- **🔊 AudioWorklet**: High-performance audio processing
- **📱 Memory Safe**: Adaptive chunk sizing to prevent iOS crashes
- **📊 Performance Monitoring**: Real-time metrics and adaptive optimization
- **🎵 Audio Management**: Full audio state tracking with duration, cache, and memory info
- **🔧 Easy Setup**: Simple API with TypeScript support

## 🚨 iOS Safari Issues This Fixes

1. **Sample Rate Mismatches**: Causes high-pitched/fast audio playback
2. **Memory Pressure**: Large audio files cause page reloads on iOS
3. **IndexedDB Failures**: Safari iOS fails IndexedDB operations randomly
4. **AudioContext Bugs**: Broken state detection and recovery

## 📦 Installation

```bash
npm install z-web-audio-stream
# or
pnpm add z-web-audio-stream
# or  
yarn add z-web-audio-stream
```

## 🚀 Quick Start

### 1. Copy the AudioWorklet file

First, copy the AudioWorklet processor to your public directory:

```bash
# Using CLI (recommended)
npx z-web-audio-stream-cli deploy

# Or manually copy from node_modules
cp node_modules/z-web-audio-stream/dist/audio-worklet-processor.js public/
```

### 2. Instant Playback with Separated Optimization (Recommended)

```typescript
import { setupInstantAudio } from 'z-web-audio-stream';

// Initialize with separated download/storage optimization
const manager = await setupInstantAudio({
  downloadChunkSize: 256 * 1024,    // 256KB downloads for network optimization
  storageChunkSize: 2 * 1024 * 1024, // 2MB chunks for IndexedDB efficiency
  playbackChunkSize: 384 * 1024,     // 384KB for instant playback start
  enablePerformanceLogging: true,     // See detailed performance metrics
  onTimeUpdate: (currentTime, duration) => {
    console.log(`Playing: ${currentTime}s / ${duration}s`);
  },
  onProgressiveLoadingStatus: (status, data) => {
    if (status === 'STARTED') {
      console.log('🚀 Separated instant playback started!');
      console.log(`Strategy: ${data.strategy}`);
    }
  }
});

// Start playing instantly - audio begins within 500ms
await manager.playInstantly('/audio/song.mp3', 'song-1', 'My Song');
```

## 🏗️ Separated Download/Storage Architecture

WebAudioStream v1.2.0+ uses a sophisticated **three-layer architecture** that separates concerns for optimal performance:

### 📡 Layer 1: Download Manager
- **Purpose**: Network transfer optimization
- **Chunk Size**: 64KB-512KB (optimized for HTTP/2 and mobile networks)
- **Features**: Parallel downloads, range requests, connection speed adaptation
- **Benefits**: Faster initial response, better network utilization

### 🔄 Layer 2: Streaming Assembler  
- **Purpose**: Real-time chunk assembly and playback preparation
- **Chunk Size**: 256KB-384KB for first playback chunk, larger for storage
- **Features**: Streaming assembly, immediate playback readiness detection
- **Benefits**: Sub-500ms playback start, seamless transitions

### 💾 Layer 3: Storage Manager
- **Purpose**: IndexedDB optimization and memory management
- **Chunk Size**: 1-3MB (optimized for browser storage efficiency)
- **Features**: iOS Safari retry logic, automatic cleanup, obfuscation
- **Benefits**: Reliable caching, memory safety, privacy protection

```
Download (256KB) → Assembly (384KB) → Storage (2MB) → Playback
     ↓               ↓                 ↓            ↓
Fast Network    Instant Start    Efficient Cache  Smooth Audio
```

### 3. Basic Usage

```typescript
import { setupWebAudio } from 'z-web-audio-stream';

// Initialize with iOS-safe defaults
const manager = await setupWebAudio({
  enableInstantPlayback: true, // Enable instant playback
  onTimeUpdate: (currentTime, duration) => {
    console.log(`Playing: ${currentTime}s / ${duration}s`);
  },
  onEnded: () => {
    console.log('Playback finished');
  },
  onError: (error) => {
    console.error('Playback error:', error);
  }
});

// Traditional loading (waits for full download)
await manager.loadAndPlay('/audio/song.mp3', 'song-1', 'My Song');

// OR use instant playback (recommended)
await manager.playInstantly('/audio/song.mp3', 'song-1', 'My Song');

// Control playback
await manager.pause();
await manager.resume();
await manager.seek(30); // Seek to 30 seconds
manager.setVolume(0.8); // 80% volume
```

### 4. Audio Management (v1.3.0+)

```typescript
import { setupInstantAudio } from 'z-web-audio-stream';

const manager = await setupInstantAudio();

// Load and play some tracks
await manager.playInstantly('/audio/song1.mp3', 'song-1', 'First Song');
await manager.playInstantly('/audio/song2.mp3', 'song-2', 'Second Song');

// Check audio state and get metadata
const isLoaded = await manager.isAudioLoaded('song-1');
console.log('Song 1 loaded:', isLoaded); // true

const duration = manager.getBufferDuration('song-1');
console.log('Song 1 duration:', duration); // e.g., 240.5 seconds

// Get all cached tracks with metadata
const cachedTracks = await manager.getCachedTracks();
cachedTracks.forEach(track => {
  console.log(`Track: ${track.name}`);
  console.log(`Duration: ${track.duration}s`);
  console.log(`Size: ${(track.size / 1024 / 1024).toFixed(1)}MB`);
  console.log(`Loaded in memory: ${track.isLoaded}`);
  console.log(`Last accessed: ${track.lastAccessed.toLocaleString()}`);
});

// Perfect for building audio players with:
// - Track duration display
// - Cache management
// - Memory usage optimization
// - Playlist state tracking
```

### 5. Advanced Configuration

```typescript
import { WebAudioManager, AudioChunkStore } from 'z-web-audio-stream';

const manager = new WebAudioManager({
  workletPath: '/audio-worklet-processor.js',
  enableCache: true,
  enableInstantPlayback: true,
  instantPlaybackConfig: {
    initialChunkSize: 384 * 1024,     // 384KB for instant start
    subsequentChunkSize: 2 * 1024 * 1024,  // 2MB for streaming
    maxInitialWaitTime: 500,          // 500ms max wait
    strategy: 'auto'                  // auto, always, never
  },
  maxCacheSize: 1024 * 1024 * 1024, // 1GB
  onProgressiveLoadingStatus: (status, data) => {
    console.log('Status:', status, data);
  }
});

await manager.initialize();

// Get performance recommendations
const strategy = manager.getPlaybackStrategy('/audio/song.mp3', {
  estimatedFileSize: 5 * 1024 * 1024,
  connectionSpeed: 'medium',
  deviceType: 'mobile'
});
console.log('Recommended strategy:', strategy);

// Use instant playback with progress tracking
await manager.playInstantly('/audio/song.mp3', 'song-1', 'My Song', {
  onChunkLoaded: (loaded, total) => {
    console.log(`Chunks loaded: ${loaded}/${total}`);
  },
  onFullyLoaded: () => {
    console.log('Full audio loaded in background');
  }
});

// Preload for smooth transitions
await manager.preloadAudio('/audio/next-song.mp3', 'song-2', 'Next Song');

// Get performance metrics
const metrics = manager.getInstantPlaybackMetrics();
console.log('Performance metrics:', metrics);
```

## 🚀 Instant Playback

### How It Works

1. **Smart Chunking**: Loads small initial chunk (256-384KB) for instant start
2. **Background Streaming**: Continues loading larger chunks (1-2MB) in background
3. **Seamless Replacement**: Replaces buffer without interrupting playback
4. **Range Request Support**: Uses HTTP Range requests when server supports them
5. **Adaptive Strategy**: Automatically chooses best approach based on conditions

### Performance Targets

- **Start Time**: < 500ms on 3G, < 200ms on WiFi
- **Buffer Switch**: < 50ms seamless transitions
- **Memory Usage**: Optimized for iOS Safari limits
- **Error Recovery**: Graceful fallback to standard loading

### Configuration Options

```typescript
const config: InstantPlaybackConfig = {
  initialChunkSize: 384 * 1024,      // First chunk size (384KB)
  subsequentChunkSize: 2 * 1024 * 1024, // Streaming chunks (2MB)
  predictiveLoadingThreshold: 0.75,   // Start next chunk at 75%
  maxInitialWaitTime: 500,           // Max wait for first chunk
  strategy: 'auto'                   // auto | always | never
};

manager.enableInstantMode(config);
```

## 🍎 iOS Safari Optimizations

### Automatic Features

- **Sample Rate Monitoring**: Detects and fixes iOS sample rate bugs
- **Memory-Safe Chunks**: 256KB-1MB chunks on iOS vs 2-8MB on desktop
- **IndexedDB Retry Logic**: 3-attempt retry with delays for Safari
- **Broken State Detection**: Plays dummy buffer to reset AudioContext
- **Instant Playback Limits**: Smaller chunks to prevent iOS memory pressure

### iOS-Specific Behavior

```typescript
import { isIOSSafari } from 'z-web-audio-stream';

if (isIOSSafari()) {
  console.log('iOS Safari detected - optimizations active');
  // All optimizations are automatic:
  // - Smaller chunk sizes
  // - Retry logic
  // - Sample rate monitoring
  // - Memory pressure handling
}
```

## 📋 API Reference

### WebAudioManager

The main class for audio management.

```typescript
class WebAudioManager {
  constructor(options?: WebAudioManagerOptions)
  
  // Core methods
  async initialize(): Promise<void>
  async loadAudio(url: string, trackId: string, progressCallback?: Function): Promise<AudioBuffer>
  async loadAndPlay(url: string, trackId: string, name?: string): Promise<void>
  async preloadAudio(url: string, trackId: string, name?: string): Promise<void>
  
  // Instant playback methods
  async playInstantly(url: string, trackId: string, name: string, options?: {
    forceInstant?: boolean;
    onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void;
    onFullyLoaded?: () => void;
  }): Promise<void>
  
  getPlaybackStrategy(url: string, options?: {
    estimatedFileSize?: number;
    connectionSpeed?: 'slow' | 'medium' | 'fast';
    deviceType?: 'mobile' | 'desktop';
  }): { strategy: 'instant' | 'progressive' | 'standard'; reasoning: string; }
  
  enableInstantMode(config?: Partial<InstantPlaybackConfig>): void
  disableInstantMode(): void
  getInstantPlaybackMetrics(): InstantPlaybackMetrics
  
  // Playback control
  async play(trackId: string): Promise<void>
  async pause(): Promise<void>
  async resume(): Promise<void>
  async seek(time: number): Promise<void>
  setVolume(volume: number): void
  getCurrentTime(): number
  
  // Audio management methods (v1.3.0+)
  getBufferDuration(trackId: string): number | null
  async isAudioLoaded(trackId: string): Promise<boolean>
  async getCachedTracks(): Promise<Array<{
    trackId: string;
    name?: string;
    duration?: number;
    size: number;
    lastAccessed: Date;
    isLoaded: boolean;
  }>>
  
  // Cleanup
  async cleanup(): Promise<void>
}
```

### AudioChunkStore

IndexedDB-based storage with iOS Safari compatibility.

```typescript
class AudioChunkStore {
  constructor(audioContext: AudioContext, instantConfig?: Partial<InstantChunkConfig>)
  
  async initialize(): Promise<void>
  async storeAudio(url: string, trackId: string, name: string, progressCallback?: ProgressCallback): Promise<AudioMetadata>
  async storeAudioStreaming(url: string, trackId: string, name: string, options?: {
    initialChunkSize?: number;
    subsequentChunkSize?: number;
    useRangeRequests?: boolean;
    progressCallback?: ProgressCallback;
  }): Promise<AudioMetadata>
  
  async getAudioBuffer(trackId: string, startChunk?: number, chunkCount?: number): Promise<AudioBuffer | null>
  async getFirstChunk(trackId: string): Promise<AudioBuffer | null>
  async getProgressiveChunks(trackId: string, startChunk?: number, maxChunks?: number): Promise<AudioBuffer | null>
  
  async isStored(trackId: string): Promise<boolean>
  async removeTrack(trackId: string): Promise<void>
  async cleanup(): Promise<void>
  
  configureInstantMode(config: Partial<InstantChunkConfig>): void
  getInstantPlaybackMetrics(): InstantPlaybackMetrics
  async getStorageInfo(): Promise<StorageInfo>
}
```

## 🔧 Framework Integrations

### Astro

Install the Astro integration:

```bash
npm install z-astro-web-audio-stream
```

```javascript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import webAudioStream from 'z-astro-web-audio-stream';

export default defineConfig({
  integrations: [
    webAudioStream({
      // Automatically copies worklet file to public/
      workletPath: '/audio-worklet-processor.js'
    })
  ]
});
```

### React/Vue/Svelte

```typescript
// hooks/useWebAudio.ts
import { useEffect, useState } from 'react';
import { setupWebAudio, WebAudioManager } from 'z-web-audio-stream';

export function useWebAudio() {
  const [manager, setManager] = useState<WebAudioManager | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    setupInstantAudio({
      onTimeUpdate: (currentTime, duration) => {
        // Handle time updates
      },
      onEnded: () => {
        // Handle playback end
      }
    }).then(audioManager => {
      setManager(audioManager);
      setIsReady(true);
    });

    return () => {
      manager?.cleanup();
    };
  }, []);

  return { manager, isReady };
}
```

## 🐛 Troubleshooting

### Common Issues

**Audio plays too fast/high-pitched on iOS**
- ✅ Fixed automatically by sample rate monitoring and iOS-safe AudioContext

**Page reloads when loading large audio files on iOS**  
- ✅ Fixed by adaptive chunk sizing (1-2MB max on iOS)

**IndexedDB errors on Safari**
- ✅ Fixed by retry logic with exponential backoff

**No audio on first interaction**
- Ensure you're calling `initialize()` after user gesture (click/touch)

### Debug Mode

```typescript
// Enable verbose logging for iOS issues
const manager = new WebAudioManager({
  // iOS debugging will automatically log sample rates, chunk sizes, etc.
});
```

## 📊 Performance

### Memory Usage
- **Desktop**: 3-8MB chunks, up to 1GB cache
- **iOS Safari**: 1-2MB chunks, intelligent cleanup  
- **Automatic**: Cache cleanup based on age and storage limits

### Network Optimization
- Progressive loading starts playback with first chunk
- Adaptive chunk sizing based on connection speed
- Preloading for seamless track transitions

## 🤝 Contributing

Issues and PRs welcome! This package specifically targets iOS Safari audio bugs.

### Common iOS Safari Issues We Fix

1. **Sample Rate Bug**: AudioContext.sampleRate changes unexpectedly
2. **Memory Pressure**: Large audio files cause page reloads  
3. **IndexedDB Reliability**: Random failures on first connection
4. **Broken AudioContext**: Requires dummy buffer to reset state

## 📄 License

MIT License - feel free to use in your projects!

## 🙏 Credits

Built by the StreamFi team to solve iOS Safari audio streaming issues. Based on research into iOS Web Audio API bugs and memory management.