# web-audio-stream

iOS Safari-safe Web Audio streaming with progressive loading and memory management.

## ✨ Features

- **🍎 iOS Safari Compatibility**: Fixes pitch/speed issues and prevents page reloads
- **⚡ Progressive Loading**: Instant playback with chunk-based streaming
- **💾 Smart Caching**: IndexedDB storage with automatic cleanup
- **🔊 AudioWorklet**: High-performance audio processing
- **📱 Memory Safe**: Adaptive chunk sizing to prevent iOS crashes
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

### 2. Basic Usage

```typescript
import { setupWebAudio } from 'z-web-audio-stream';

// Initialize with iOS-safe defaults
const manager = await setupWebAudio({
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

// Load and play audio
await manager.loadAndPlay('/audio/song.mp3', 'song-1', 'My Song');

// Control playback
await manager.pause();
await manager.resume();
await manager.seek(30); // Seek to 30 seconds
manager.setVolume(0.8); // 80% volume
```

### 3. Advanced Usage

```typescript
import { WebAudioManager, AudioChunkStore } from 'z-web-audio-stream';

const manager = new WebAudioManager({
  workletPath: '/audio-worklet-processor.js',
  enableCache: true,
  maxCacheSize: 1024 * 1024 * 1024, // 1GB
  onProgressiveLoadingStatus: (status, data) => {
    if (status === 'STARTED') {
      console.log('Progressive loading started');
    }
  }
});

await manager.initialize();

// Preload for smooth transitions
await manager.preloadAudio('/audio/next-song.mp3', 'song-2', 'Next Song');

// Load with progress tracking
await manager.loadAudio('/audio/large-file.mp3', 'song-3', (loaded, total) => {
  console.log(`Loading: ${Math.round(loaded/total*100)}%`);
});
```

## 🍎 iOS Safari Optimizations

### Automatic Features

- **Sample Rate Monitoring**: Detects and fixes iOS sample rate bugs
- **Memory-Safe Chunks**: 1-2MB chunks on iOS vs 8MB on desktop
- **IndexedDB Retry Logic**: 3-attempt retry with delays for Safari
- **Broken State Detection**: Plays dummy buffer to reset AudioContext

### iOS-Specific Behavior

```typescript
import { isIOSSafari } from 'z-web-audio-stream';

if (isIOSSafari()) {
  console.log('iOS Safari detected - optimizations active');
  // Smaller chunk sizes, retry logic, sample rate monitoring all automatic
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
  
  // Playback control
  async play(trackId: string): Promise<void>
  async pause(): Promise<void>
  async resume(): Promise<void>
  async seek(time: number): Promise<void>
  setVolume(volume: number): void
  getCurrentTime(): number
  
  // Cleanup
  async cleanup(): Promise<void>
}
```

### AudioChunkStore

IndexedDB-based storage with iOS Safari compatibility.

```typescript
class AudioChunkStore {
  constructor(audioContext: AudioContext)
  
  async initialize(): Promise<void>
  async storeAudio(url: string, trackId: string, name: string, progressCallback?: ProgressCallback): Promise<AudioMetadata>
  async getAudioBuffer(trackId: string, startChunk?: number, chunkCount?: number): Promise<AudioBuffer | null>
  async isStored(trackId: string): Promise<boolean>
  async removeTrack(trackId: string): Promise<void>
  async cleanup(): Promise<void>
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
    setupWebAudio({
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