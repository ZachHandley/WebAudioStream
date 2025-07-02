---
'@zachhandley/web-audio-stream': major
'@zachhandley/web-audio-stream-cli': major
'@zachhandley/astro-web-audio-stream': major
---

Initial release of WebAudioStream - iOS Safari-safe Web Audio streaming

- iOS-safe AudioContext initialization to fix pitch/speed issues
- Memory-safe progressive loading to prevent page reloads
- IndexedDB-based caching with Safari-specific retry logic
- AudioWorklet-based playback with sample rate monitoring
- CLI tool for worklet deployment
- Astro integration for seamless setup

