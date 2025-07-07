# @zachhandley/astro-web-audio-stream

## 1.1.0

### Minor Changes

- Updated to use z-web-audio-stream v1.1.0 with instant playback support
- Enhanced Astro integration with instant playback configuration options
- Added support for automatic instant playback optimization

### Patch Changes

- Updated dependencies
  - z-web-audio-stream@1.1.0

## 1.0.0

### Major Changes

- c7ffa84: Initial release of WebAudioStream - iOS Safari-safe Web Audio streaming

  - iOS-safe AudioContext initialization to fix pitch/speed issues
  - Memory-safe progressive loading to prevent page reloads
  - IndexedDB-based caching with Safari-specific retry logic
  - AudioWorklet-based playback with sample rate monitoring
  - CLI tool for worklet deployment
  - Astro integration for seamless setup

### Patch Changes

- Updated dependencies [c7ffa84]
  - @zachhandley/web-audio-stream@1.0.0
