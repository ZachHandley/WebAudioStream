# @zachhandley/web-audio-stream

## 1.4.0

### Minor Changes

- **Custom Obfuscation Keys**: Users can now provide their own obfuscation key for privacy
- Added `obfuscationKey` option to `WebAudioManagerOptions`, `setupWebAudio()`, and `setupInstantAudio()`
- Enhanced privacy with app-specific data isolation in IndexedDB storage
- Backward compatible with existing cached data using default obfuscation key

### Features

- **Privacy Control**: Set custom obfuscation keys to prevent cross-app data access
- **Data Isolation**: Each app can use different keys for secure data separation
- **Simple Integration**: Single optional parameter for enhanced privacy
- **Backward Compatibility**: Existing data continues to work seamlessly

## 1.3.0

### Minor Changes

- Added comprehensive audio management methods for full-fledged audio control
- **New Methods**: `getBufferDuration()`, `isAudioLoaded()`, `getCachedTracks()`
- Enhanced cache management with detailed track metadata and access times
- Improved audio state tracking and buffer duration access
- Better integration for building complete audio player applications

### Features

- **Audio State Management**: Check if tracks are loaded in memory or cached
- **Buffer Duration Access**: Get duration of loaded audio buffers by track ID
- **Cache Inspection**: Retrieve all cached tracks with metadata, sizes, and access times
- **Memory Optimization**: Track which audio is loaded vs cached for efficient memory usage

## 1.2.0

### Minor Changes

- **Separated Download/Storage Architecture**: Independent optimization of network transfers and storage
- **Three-Layer System**: DownloadManager (64KB-512KB) → StreamingAssembler (256KB-384KB) → AudioChunkStore (1-3MB)
- Enhanced `playInstantly()` method with separated chunking strategy
- Added `DownloadManager` class for network-optimized parallel downloads
- Added `StreamingAssembler` class for real-time chunk assembly and playback preparation
- Improved range request support with HTTP/2 optimization
- Better iOS Safari memory pressure handling with adaptive chunk sizing

### Features

- **Download Optimization**: Network chunks (64KB-512KB) separate from storage chunks (1-3MB)
- **Streaming Assembly**: Real-time assembly for sub-500ms playback start
- **Parallel Downloads**: Configurable concurrent downloads with priority first chunk
- **Adaptive Sizing**: Connection speed-based chunk size optimization
- **Performance Monitoring**: Detailed metrics for download, assembly, and storage phases

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
