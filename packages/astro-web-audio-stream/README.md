# @web-audio-stream/astro

Astro integration for Web Audio Stream with automatic worklet deployment.

## 🍎 What This Fixes

This integration automatically sets up iOS Safari-safe audio streaming that fixes:

- **Sample Rate Mismatches** - High-pitched/fast audio playback  
- **Memory Pressure** - Page reloads from large audio files
- **IndexedDB Failures** - Safari connection issues
- **Broken AudioContext** - iOS-specific Web Audio bugs

## 📦 Installation

```bash
npm install @web-audio-stream/astro web-audio-stream
# or
pnpm add @web-audio-stream/astro web-audio-stream
```

## 🚀 Setup

Add the integration to your `astro.config.mjs`:

```javascript
import { defineConfig } from 'astro/config';
import webAudioStream from '@web-audio-stream/astro';

export default defineConfig({
  integrations: [
    webAudioStream({
      // Optional configuration
      workletPath: '/audio-worklet-processor.js',
      publicDir: 'public',
      autoDeploy: true,
      verbose: true
    })
  ]
});
```

## ⚙️ Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workletPath` | `string` | `'/audio-worklet-processor.js'` | URL path where worklet will be served |
| `publicDir` | `string` | `'public'` | Public directory relative to project root |
| `autoDeploy` | `boolean` | `true` | Automatically copy worklet during build |
| `verbose` | `boolean` | `true` | Log deployment information |

## 🎵 Usage in Components

### Astro Component

```astro
---
// src/components/AudioPlayer.astro
---

<div id="audio-player">
  <button id="play-btn">Play</button>
  <button id="pause-btn">Pause</button>
</div>

<script>
  import { setupWebAudio } from 'web-audio-stream';
  
  // Initialize with iOS-safe defaults
  const manager = await setupWebAudio({
    workletPath: '/audio-worklet-processor.js', // Automatically deployed!
    onTimeUpdate: (currentTime, duration) => {
      console.log(`Playing: ${currentTime}s / ${duration}s`);
    },
    onEnded: () => {
      console.log('Playback finished');
    }
  });
  
  // Control buttons
  document.getElementById('play-btn')?.addEventListener('click', async () => {
    await manager.loadAndPlay('/audio/song.mp3', 'song-1', 'My Song');
  });
  
  document.getElementById('pause-btn')?.addEventListener('click', async () => {
    await manager.pause();
  });
</script>
```

### React Component (in Astro)

```tsx
// src/components/ReactAudioPlayer.tsx
import { useEffect, useState } from 'react';
import { setupWebAudio, type WebAudioManager } from 'web-audio-stream';

export default function ReactAudioPlayer() {
  const [manager, setManager] = useState<WebAudioManager | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setupWebAudio({
      workletPath: '/audio-worklet-processor.js', // Auto-deployed by integration
      onTimeUpdate: (time, dur) => {
        setCurrentTime(time);
        setDuration(dur);
      },
      onEnded: () => {
        setIsPlaying(false);
      }
    }).then(setManager);

    return () => {
      manager?.cleanup();
    };
  }, []);

  const handlePlay = async () => {
    if (!manager) return;
    
    await manager.loadAndPlay('/audio/song.mp3', 'song-1', 'My Song');
    setIsPlaying(true);
  };

  const handlePause = async () => {
    if (!manager) return;
    
    await manager.pause();
    setIsPlaying(false);
  };

  return (
    <div className="audio-player">
      <button onClick={isPlaying ? handlePause : handlePlay}>
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      
      {duration > 0 && (
        <div className="progress">
          <div 
            className="progress-bar"
            style={{ width: `${(currentTime / duration) * 100}%` }}
          />
        </div>
      )}
      
      <span>{Math.floor(currentTime)}s / {Math.floor(duration)}s</span>
    </div>
  );
}
```

## 🏗️ Build Process

During build, the integration:

1. ✅ **Finds** the iOS-safe audio worklet processor
2. ✅ **Copies** it to your public directory  
3. ✅ **Configures** the correct path automatically
4. ✅ **Logs** deployment status (if verbose enabled)

**Build Output:**
```
🎵 Web Audio Stream integration loaded
🍎 iOS Safari audio fixes will be applied automatically
✅ Audio worklet deployed to: /path/to/public/audio-worklet-processor.js
🔧 Use in your app: setupWebAudio({ workletPath: "/audio-worklet-processor.js" })
```

## 🔧 Manual Deployment

If you prefer manual control:

```javascript
// astro.config.mjs
export default defineConfig({
  integrations: [
    webAudioStream({
      autoDeploy: false // Disable automatic deployment
    })
  ]
});
```

Then deploy manually:
```bash
npx web-audio-stream-cli deploy
```

## 🍎 iOS Safari Benefits

This integration ensures your Astro site works perfectly on iOS Safari:

- **✅ No High-Pitched Audio** - Sample rate monitoring and correction
- **✅ No Page Reloads** - Memory-safe 1-2MB chunks on iOS  
- **✅ Reliable Caching** - IndexedDB retry logic for Safari
- **✅ Instant Playback** - Progressive loading with first chunk
- **✅ Zero Configuration** - Works out of the box

## 📱 Mobile-First Examples

### Progressive Loading with Preloading

```astro
<script>
  import { setupWebAudio } from 'web-audio-stream';
  
  const manager = await setupWebAudio();
  
  // Preload next tracks for seamless transitions
  await manager.preloadAudio('/audio/song1.mp3', 'song-1', 'Song 1');
  await manager.preloadAudio('/audio/song2.mp3', 'song-2', 'Song 2'); 
  
  // Play immediately (loads from cache)
  await manager.loadAndPlay('/audio/song1.mp3', 'song-1', 'Song 1');
</script>
```

### Playlist with iOS Optimizations

```tsx
function Playlist({ songs }) {
  const [manager, setManager] = useState<WebAudioManager | null>(null);
  const [currentSong, setCurrentSong] = useState(0);

  useEffect(() => {
    setupWebAudio({
      onEnded: () => {
        // Auto-advance to next song
        setCurrentSong(prev => (prev + 1) % songs.length);
      }
    }).then(async (audioManager) => {
      setManager(audioManager);
      
      // Preload all songs for iOS-safe smooth playback
      for (const song of songs) {
        await audioManager.preloadAudio(song.url, song.id, song.name);
      }
    });
  }, [songs]);

  const playSong = async (index: number) => {
    if (!manager) return;
    
    const song = songs[index];
    await manager.loadAndPlay(song.url, song.id, song.name);
    setCurrentSong(index);
  };

  return (
    <div className="playlist">
      {songs.map((song, index) => (
        <button
          key={song.id}
          onClick={() => playSong(index)}
          className={currentSong === index ? 'active' : ''}
        >
          {song.name}
        </button>
      ))}
    </div>
  );
}
```

## 🔍 Troubleshooting

**Integration not found**
```bash
npm install @web-audio-stream/astro
```

**Worklet file not deployed**
- Check that `autoDeploy: true` (default)
- Verify `web-audio-stream` is installed
- Check build logs for error messages

**iOS audio still has issues**
- Ensure you're using the deployed worklet path
- Check browser console for iOS-specific logs
- Verify the integration ran during build

## 📄 License

MIT License - Part of the Web Audio Stream package suite.