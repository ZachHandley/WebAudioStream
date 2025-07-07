# @zachhandley/web-audio-stream

## 1.1.0

### Minor Changes

- Enhanced instant playback implementation with Range request support
- Added true streaming chunks for sub-500ms playback start times
- Improved performance monitoring and adaptive chunk sizing
- Added getPlaybackStrategy() method for optimal loading recommendations
- Enhanced AudioChunkStore with storeAudioStreaming() method
- Added performance metrics tracking in audio worklet processor
- Better iOS Safari optimizations for instant playback mode
- Added enableInstantMode() and disableInstantMode() methods
- Comprehensive instant playback API with progress callbacks

### Features

- **Instant Playback**: Start audio within 100-500ms using smart chunking
- **Range Request Support**: Efficient partial content loading when supported
- **Performance Monitoring**: Real-time metrics and buffer underrun detection
- **Adaptive Strategy**: Automatic optimization based on connection and device
- **Enhanced iOS Compatibility**: Optimized chunk sizes for Safari memory limits

## 1.0.0

### Major Changes

- c7ffa84: Initial release of WebAudioStream - iOS Safari-safe Web Audio streaming

  - iOS-safe AudioContext initialization to fix pitch/speed issues
  - Memory-safe progressive loading to prevent page reloads
  - IndexedDB-based caching with Safari-specific retry logic
  - AudioWorklet-based playback with sample rate monitoring
  - CLI tool for worklet deployment
  - Astro integration for seamless setup
