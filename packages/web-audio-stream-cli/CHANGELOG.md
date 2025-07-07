# @zachhandley/web-audio-stream-cli

## 1.1.0

### Minor Changes

- Updated to support deployment of enhanced audio worklet with instant playback features
- Added instant playback performance monitoring support
- Enhanced worklet processor with buffer underrun detection

## 1.0.0

### Major Changes

- c7ffa84: Initial release of WebAudioStream - iOS Safari-safe Web Audio streaming

  - iOS-safe AudioContext initialization to fix pitch/speed issues
  - Memory-safe progressive loading to prevent page reloads
  - IndexedDB-based caching with Safari-specific retry logic
  - AudioWorklet-based playback with sample rate monitoring
  - CLI tool for worklet deployment
  - Astro integration for seamless setup
