// WebAudioManager.ts
// iOS Safari-safe Web Audio manager with progressive streaming and memory management
// Fixes pitch/speed issues and prevents page reloads on iOS Safari

import { AudioChunkStore, type ProgressCallback } from './AudioChunkStore.js';
import { DownloadManager, type DownloadStrategy, type DownloadProgress } from './DownloadManager.js';
import { StreamingAssembler, type AssemblyChunk } from './StreamingAssembler.js';

export interface WebAudioManagerOptions {
  workletPath?: string;
  enableCache?: boolean;
  maxCacheSize?: number;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
  onProgressiveLoadingStatus?: (status: 'STARTED' | 'PROGRESS' | 'COMPLETED' | 'FAILED', data?: any) => void;
  // Instant playback options
  enableInstantPlayback?: boolean;
  instantPlaybackConfig?: InstantPlaybackConfig;
}

export interface InstantPlaybackConfig {
  // Download strategy options
  downloadStrategy?: Partial<DownloadStrategy>;
  // Storage chunk size for IndexedDB efficiency (1-3MB)
  storageChunkSize?: number;
  // Playback chunk size for instant start (256KB-512KB)  
  playbackChunkSize?: number;
  // Maximum time to wait for initial chunk (ms)
  maxInitialWaitTime?: number;
  // Strategy for determining if instant playback should be used
  strategy?: 'auto' | 'always' | 'never';
  // Enable detailed performance logging
  enablePerformanceLogging?: boolean;
}

// Legacy InstantPlaybackSession interface (deprecated in v1.2.0)
// TODO: Remove in v2.0.0 when old implementation is fully removed
interface InstantPlaybackSession {
  trackId: string;
  url: string;
  name: string;
  startTime: number;
  isActive: boolean;
  currentChunk: number;
  totalChunks: number;
  loadedChunks: Set<number>;
  chunkLoadingPromises: Map<number, Promise<void>>;
  predictiveLoadingActive: boolean;
  audioBuffer: AudioBuffer | null;
  metadata: {
    duration: number;
    sampleRate: number;
    numberOfChannels: number;
    totalSamples: number;
  } | null;
}

/**
 * iOS Safari-safe Web Audio manager with progressive streaming
 * 
 * Key features:
 * - iOS-safe AudioContext initialization to fix pitch/speed issues
 * - Memory-safe progressive loading to prevent page reloads  
 * - IndexedDB-based caching with Safari-specific retry logic
 * - AudioWorklet-based playback with sample rate monitoring
 * - Automatic cleanup and storage management
 */
export class WebAudioManager {
  private audioContext: AudioContext | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private audioBuffers: Map<string, AudioBuffer> = new Map();
  private currentTrackId: string | null = null;
  private isInitialized = false;
  private preloadQueue: Set<string> = new Set();
  private chunkStore: AudioChunkStore | null = null;
  
  // Event callbacks
  private onTimeUpdate?: (currentTime: number, duration: number) => void;
  private onEnded?: () => void;
  private onError?: (error: Error) => void;
  private onProgressiveLoadingStatus?: (status: 'STARTED' | 'PROGRESS' | 'COMPLETED' | 'FAILED', data?: any) => void;
  
  // Position tracking
  private lastKnownPosition: number = 0;
  private positionRequestResolvers: Map<string, (position: { currentTime: number, samplePosition: number }) => void> = new Map();
  
  // iOS Safari specific properties
  private iosSafariDetected: boolean = false;
  private lastKnownSampleRate: number = 0;
  private sampleRateMonitorInterval: number | null = null;
  private silentBuffer: AudioBuffer | null = null;
  
  // Chunked transfer settings (iOS optimized)
  private readonly MAX_TRANSFER_SIZE = this.isIOSSafari() ? 2 * 1024 * 1024 : 8 * 1024 * 1024; // 2MB for iOS, 8MB for others
  
  // Download and streaming components
  private downloadManager: DownloadManager | null = null;
  private streamingAssembler: StreamingAssembler | null = null;
  
  // Configuration
  private workletPath: string;
  private enableCache: boolean;
  private enableInstantPlayback: boolean;
  private instantPlaybackConfig: InstantPlaybackConfig;
  
  // Legacy instant playback state (deprecated, TODO: remove in v2.0.0)
  private instantPlaybackSessions: Map<string, InstantPlaybackSession> = new Map();
  private defaultInstantConfig: InstantPlaybackConfig = {
    downloadStrategy: {
      initialChunkSize: 256 * 1024, // 256KB for network downloads
      standardChunkSize: 512 * 1024, // 512KB for subsequent downloads
      maxConcurrentDownloads: 4,
      priorityFirstChunk: true,
      adaptiveChunkSizing: true
    },
    storageChunkSize: 2 * 1024 * 1024, // 2MB for IndexedDB storage
    playbackChunkSize: 384 * 1024, // 384KB for instant playback
    maxInitialWaitTime: 500, // 500ms max wait for initial chunk
    strategy: 'auto',
    enablePerformanceLogging: false
  };

  constructor(options: WebAudioManagerOptions = {}) {
    this.workletPath = options.workletPath || '/audio-worklet-processor.js';
    this.enableCache = options.enableCache !== false;
    this.onTimeUpdate = options.onTimeUpdate;
    this.onEnded = options.onEnded;
    this.onError = options.onError;
    this.onProgressiveLoadingStatus = options.onProgressiveLoadingStatus;
    
    // Initialize instant playback settings
    this.enableInstantPlayback = options.enableInstantPlayback !== false;
    this.instantPlaybackConfig = { 
      ...this.defaultInstantConfig, 
      ...options.instantPlaybackConfig,
      // Merge download strategy
      downloadStrategy: {
        ...this.defaultInstantConfig.downloadStrategy,
        ...options.instantPlaybackConfig?.downloadStrategy
      }
    };
    
    // Detect iOS Safari
    this.iosSafariDetected = this.isIOSSafari();
    if (this.iosSafariDetected) {
      console.log('[WebAudioManager] iOS Safari detected - applying iOS-specific optimizations');
    }
    
    // Initialize on first user interaction
    this.initializeOnUserGesture();
  }

  // iOS Safari detection
  private isIOSSafari(): boolean {
    if (typeof navigator === 'undefined') return false;
    
    const userAgent = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(userAgent);
    const isSafari = /Safari/.test(userAgent) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(userAgent);
    
    return isIOS && isSafari;
  }

  private initializeOnUserGesture() {
    // SSR Guard
    if (typeof document === 'undefined') {
      return;
    }
    
    const initializeAudio = async () => {
      if (!this.isInitialized) {
        await this.initialize();
        document.removeEventListener('click', initializeAudio);
        document.removeEventListener('touchstart', initializeAudio);
      }
    };
    
    document.addEventListener('click', initializeAudio, { once: true });
    document.addEventListener('touchstart', initializeAudio, { once: true });
  }

  // iOS-safe AudioContext creation - implements the ios-safe-audio-context pattern
  private async createIOSSafeAudioContext(): Promise<AudioContext> {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    
    if (!this.iosSafariDetected) {
      // Non-iOS: standard AudioContext creation
      return new AudioContextClass();
    }
    
    console.log('[WebAudioManager] Creating iOS-safe AudioContext...');
    
    // iOS-safe pattern: Create temporary context to detect broken state
    let tempContext: AudioContext | null = null;
    let finalContext: AudioContext;
    
    try {
      // Step 1: Create temporary AudioContext to check for broken state
      tempContext = new AudioContextClass();
      const detectedSampleRate = tempContext.sampleRate;
      
      console.log(`[WebAudioManager] iOS temporary context sample rate: ${detectedSampleRate}Hz`);
      
      // Step 2: Check if the sample rate suggests a broken state
      // iOS broken state typically shows unexpected sample rates
      const isBrokenState = detectedSampleRate !== 44100 && detectedSampleRate !== 48000;
      
      if (isBrokenState) {
        console.log('[WebAudioManager] iOS broken state detected, playing dummy buffer...');
        
        // Step 3: Play dummy buffer to reset state
        await this.playDummyBuffer(tempContext);
        
        // Step 4: Close broken context
        await tempContext.close();
        tempContext = null;
        
        // Step 5: Create new context which should have correct sample rate
        finalContext = new AudioContextClass();
        console.log(`[WebAudioManager] iOS fixed context sample rate: ${finalContext.sampleRate}Hz`);
      } else {
        // Sample rate looks good, use the temporary context
        finalContext = tempContext;
        tempContext = null;
        console.log('[WebAudioManager] iOS context sample rate is acceptable');
      }
      
      return finalContext;
      
    } catch (error) {
      console.error('[WebAudioManager] iOS-safe AudioContext creation failed:', error);
      
      // Cleanup temporary context if it exists
      if (tempContext) {
        try {
          await tempContext.close();
        } catch (cleanupError) {
          console.warn('[WebAudioManager] Failed to cleanup temporary context:', cleanupError);
        }
      }
      
      // Fallback to standard AudioContext creation
      return new AudioContextClass();
    }
  }

  // Play dummy buffer to reset iOS AudioContext state
  private async playDummyBuffer(context: AudioContext): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Create very short silent buffer
        const sampleRate = context.sampleRate;
        const buffer = context.createBuffer(1, Math.ceil(sampleRate * 0.01), sampleRate); // 10ms silence
        
        // Create and configure source
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        
        // Play dummy buffer
        source.onended = () => {
          console.log('[WebAudioManager] iOS dummy buffer played successfully');
          resolve();
        };
        
        source.start();
        
        // Timeout fallback
        setTimeout(() => {
          console.warn('[WebAudioManager] iOS dummy buffer timeout, continuing...');
          resolve();
        }, 100);
        
      } catch (error) {
        console.warn('[WebAudioManager] Failed to play iOS dummy buffer:', error);
        resolve(); // Continue anyway
      }
    });
  }

  // Create silent buffer for iOS AudioContext reset trick
  private async createSilentBuffer(): Promise<AudioBuffer> {
    if (!this.audioContext) throw new Error('AudioContext not initialized');
    
    const sampleRate = this.audioContext.sampleRate;
    const length = Math.floor(sampleRate * 0.1); // 100ms of silence
    const buffer = this.audioContext.createBuffer(1, length, sampleRate);
    
    return buffer;
  }

  // iOS Safari sample rate monitoring and correction
  private startSampleRateMonitoring(): void {
    if (!this.iosSafariDetected || !this.audioContext) return;
    
    this.lastKnownSampleRate = this.audioContext.sampleRate;
    
    // Monitor sample rate changes every 1 second
    this.sampleRateMonitorInterval = window.setInterval(() => {
      if (!this.audioContext) return;
      
      const currentSampleRate = this.audioContext.sampleRate;
      if (currentSampleRate !== this.lastKnownSampleRate) {
        console.warn(`[WebAudioManager] iOS sample rate changed: ${this.lastKnownSampleRate}Hz → ${currentSampleRate}Hz`);
        this.handleSampleRateChange(currentSampleRate);
        this.lastKnownSampleRate = currentSampleRate;
      }
    }, 1000);
  }

  // Handle sample rate changes with silent audio trick
  private async handleSampleRateChange(newSampleRate: number): Promise<void> {
    if (!this.audioContext || !this.iosSafariDetected) return;
    
    try {
      console.log('[WebAudioManager] Applying iOS sample rate correction...');
      
      // Create and play silent buffer to reset AudioContext
      if (!this.silentBuffer) {
        this.silentBuffer = await this.createSilentBuffer();
      }
      
      // Play silent audio to stabilize sample rate
      const source = this.audioContext.createBufferSource();
      source.buffer = this.silentBuffer;
      source.connect(this.audioContext.destination);
      source.start();
      
      // Update any cached sample rates in worklet
      if (this.audioWorkletNode) {
        this.audioWorkletNode.port.postMessage({
          type: 'SAMPLE_RATE_UPDATE',
          sampleRate: newSampleRate
        });
      }
      
      console.log(`[WebAudioManager] iOS sample rate correction applied: ${newSampleRate}Hz`);
    } catch (error) {
      console.error('[WebAudioManager] Failed to handle sample rate change:', error);
    }
  }

  async initialize(): Promise<void> {
    // SSR Guard
    if (typeof window === 'undefined') {
      throw new Error('Web Audio API not available on server-side');
    }
    
    try {
      // Create AudioContext with iOS-safe initialization
      this.audioContext = await this.createIOSSafeAudioContext();
      
      // Resume context if it's suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      // Load and register the AudioWorklet
      await this.audioContext.audioWorklet.addModule(this.workletPath);
      
      // Create AudioWorklet node
      this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-playback-processor');
      
      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();
      
      // Connect: AudioWorklet -> Gain -> Destination
      this.audioWorkletNode.connect(this.gainNode);
      this.gainNode.connect(this.audioContext.destination);
      
      // Set up message handling
      this.setupWorkletMessageHandling();
      
      // Initialize chunk store if caching is enabled
      if (this.enableCache) {
        this.chunkStore = new AudioChunkStore(this.audioContext);
        await this.chunkStore.initialize();
      }
      
      // iOS Safari specific initialization
      if (this.iosSafariDetected) {
        console.log('[WebAudioManager] Applying iOS Safari optimizations...');
        
        // Create silent buffer for sample rate corrections
        try {
          this.silentBuffer = await this.createSilentBuffer();
          console.log('[WebAudioManager] iOS silent buffer created successfully');
        } catch (error) {
          console.warn('[WebAudioManager] Failed to create iOS silent buffer:', error);
        }
        
        // Start sample rate monitoring
        this.startSampleRateMonitoring();
        
        // Send initial iOS configuration to worklet
        this.audioWorkletNode.port.postMessage({
          type: 'IOS_CONFIG',
          isIOSSafari: true,
          sampleRate: this.audioContext.sampleRate,
          maxChunkSize: this.MAX_TRANSFER_SIZE
        });
      }
      
      this.isInitialized = true;
      console.log(`[WebAudioManager] Initialized successfully - AudioContext sample rate: ${this.audioContext.sampleRate}Hz${this.iosSafariDetected ? ' (iOS optimized)' : ''}`);
      
    } catch (error) {
      console.error('Failed to initialize Web Audio API:', error);
      this.onError?.(error as Error);
      throw error;
    }
  }

  private setupWorkletMessageHandling() {
    if (!this.audioWorkletNode) return;
    
    this.audioWorkletNode.port.onmessage = (event) => {
      const { type, currentTime, duration } = event.data;
      
      switch (type) {
        case 'TIME_UPDATE':
          this.lastKnownPosition = currentTime;
          this.onTimeUpdate?.(currentTime, duration);
          break;
          
        case 'ENDED':
          this.onEnded?.();
          break;
          
        case 'POSITION_RESPONSE':
          this.lastKnownPosition = currentTime;
          break;
          
        case 'CURRENT_POSITION_RESPONSE':
          this.lastKnownPosition = currentTime;
          // Handle real-time position request
          const { requestId, samplePosition } = event.data;
          if (requestId && this.positionRequestResolvers.has(requestId)) {
            const resolver = this.positionRequestResolvers.get(requestId)!;
            resolver({ currentTime, samplePosition });
            this.positionRequestResolvers.delete(requestId);
          }
          break;
          
        case 'BUFFER_SWITCHED':
          // Progressive buffer switch completed
          const { newBufferIndex, newDuration } = event.data;
          console.log(`[WebAudioManager] Progressive buffer switch completed - Buffer ${newBufferIndex}, Duration: ${newDuration}s`);
          break;
      }
    };
  }

  // Load and decode audio from URL
  async loadAudio(url: string, trackId: string, progressCallback?: (loaded: number, total: number) => void): Promise<AudioBuffer> {
    if (!this.audioContext) {
      await this.initialize();
    }
    
    try {
      // Check if already loaded
      if (this.audioBuffers.has(trackId)) {
        return this.audioBuffers.get(trackId)!;
      }
      
      console.log(`Loading audio: ${trackId}`);
      
      // Fetch audio data with progress tracking
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch audio: ${response.status}`);
      }
      
      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      
      if (!response.body) {
        throw new Error('ReadableStream not supported');
      }
      
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      
      // Read chunks progressively
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        chunks.push(value);
        loaded += value.length;
        
        // Call progress callback
        if (progressCallback && total > 0) {
          progressCallback(loaded, total);
        }
      }
      
      // Combine all chunks into single ArrayBuffer
      const arrayBuffer = new ArrayBuffer(loaded);
      const uint8Array = new Uint8Array(arrayBuffer);
      let offset = 0;
      
      for (const chunk of chunks) {
        uint8Array.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Decode audio data
      const audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);
      
      // Enhanced iOS debugging for sample rate issues
      const contextSampleRate = this.audioContext!.sampleRate;
      const bufferSampleRate = audioBuffer.sampleRate;
      
      if (this.iosSafariDetected) {
        console.log(`[WebAudioManager] 🍎 iOS Safari audio decode complete:`);
        console.log(`  - AudioContext: ${contextSampleRate}Hz`);
        console.log(`  - AudioBuffer: ${bufferSampleRate}Hz`);
        console.log(`  - Channels: ${audioBuffer.numberOfChannels}`);
        console.log(`  - Duration: ${audioBuffer.duration.toFixed(3)}s`);
        
        if (contextSampleRate !== bufferSampleRate) {
          console.warn(`[WebAudioManager] 🍎 iOS SAMPLE RATE MISMATCH DETECTED! This may cause high-pitched audio.`);
          
          // Apply iOS sample rate correction immediately
          try {
            await this.handleSampleRateChange(contextSampleRate);
          } catch (error) {
            console.error('[WebAudioManager] Failed to apply immediate iOS sample rate correction:', error);
          }
        }
      }
      
      // Cache the buffer
      this.audioBuffers.set(trackId, audioBuffer);
      console.log(`Audio loaded and cached: ${trackId}`);
      
      return audioBuffer;
      
    } catch (error) {
      console.error(`Failed to load audio ${trackId}:`, error);
      this.onError?.(error as Error);
      throw error;
    }
  }

  // Play audio from loaded buffer
  async play(trackId: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const audioBuffer = this.audioBuffers.get(trackId);
    if (!audioBuffer) {
      throw new Error(`Audio buffer not found for track: ${trackId}`);
    }

    this.currentTrackId = trackId;

    // Extract channel data for worklet
    const channelData: Float32Array[] = [];
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      channelData.push(audioBuffer.getChannelData(i));
    }

    // Send buffer to worklet
    this.audioWorkletNode!.port.postMessage({
      type: 'SET_BUFFER',
      trackId,
      channelData,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      totalSamples: audioBuffer.length
    });

    // Start playback
    this.audioWorkletNode!.port.postMessage({ type: 'PLAY' });
  }

  // Load and play audio with progressive loading
  async loadAndPlay(url: string, trackId: string, name?: string): Promise<void> {
    // First check if we have it cached
    if (this.chunkStore && this.enableCache) {
      const isStored = await this.chunkStore.isStored(trackId);
      if (isStored) {
        console.log(`[WebAudioManager] Loading from cache: ${trackId}`);
        const audioBuffer = await this.chunkStore.getAudioBuffer(trackId);
        if (audioBuffer) {
          this.audioBuffers.set(trackId, audioBuffer);
          await this.play(trackId);
          return;
        }
      }
    }

    // Load from network
    const audioBuffer = await this.loadAudio(url, trackId);
    
    // Store in cache if enabled
    if (this.chunkStore && this.enableCache && name) {
      try {
        await this.chunkStore.storeAudio(url, trackId, name);
      } catch (error) {
        console.warn(`[WebAudioManager] Failed to cache audio: ${error}`);
      }
    }
    
    await this.play(trackId);
  }

  // Instant playback - starts playing first chunk immediately while loading rest
  async playInstantly(url: string, trackId: string, name: string, options?: {
    forceInstant?: boolean;
    onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void;
    onFullyLoaded?: () => void;
    onDownloadProgress?: (progress: DownloadProgress) => void;
  }): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // Check if instant playback should be used
    if (!this.shouldUseInstantPlayback(url, options?.forceInstant)) {
      console.log(`[WebAudioManager] Using standard playback for ${trackId}`);
      return this.loadAndPlay(url, trackId, name);
    }

    console.log(`[WebAudioManager] 🚀 Starting separated download/storage instant playback for ${name} (${trackId})`);
    const startTime = Date.now();
    
    try {
      this.onProgressiveLoadingStatus?.('STARTED', { trackId, strategy: 'separated-instant' });
      
      // Create download manager with optimized settings
      this.downloadManager = new DownloadManager({
        strategy: this.instantPlaybackConfig.downloadStrategy,
        onProgress: (progress) => {
          options?.onDownloadProgress?.(progress);
          if (this.instantPlaybackConfig.enablePerformanceLogging) {
            console.log(`[WebAudioManager] Download progress: ${(progress.bytesLoaded / 1024 / 1024).toFixed(2)}MB/${(progress.bytesTotal / 1024 / 1024).toFixed(2)}MB (${(progress.downloadSpeed / 1024 / 1024).toFixed(2)}MB/s)`);
          }
        },
        onError: (error) => {
          console.error(`[WebAudioManager] Download error: ${error}`);
          this.onError?.(error);
        }
      });
      
      // Create streaming assembler
      this.streamingAssembler = new StreamingAssembler({
        storageChunkSize: this.instantPlaybackConfig.storageChunkSize || 2 * 1024 * 1024,
        playbackChunkSize: this.instantPlaybackConfig.playbackChunkSize || 384 * 1024,
        onPlaybackReady: async (firstChunk) => {
          const initialLoadTime = Date.now() - startTime;
          console.log(`[WebAudioManager] 🎵 First chunk ready for playback in ${initialLoadTime}ms (${(firstChunk.totalSize / 1024).toFixed(0)}KB)`);
          
          // Decode and start playback with first chunk
          await this.startPlaybackWithChunk(trackId, firstChunk);
        },
        onChunkAssembled: (assemblyChunk) => {
          if (this.instantPlaybackConfig.enablePerformanceLogging) {
            console.log(`[WebAudioManager] Assembled chunk ${assemblyChunk.storageIndex}: ${(assemblyChunk.totalSize / 1024).toFixed(0)}KB from ${assemblyChunk.downloadChunks.length} download chunks`);
          }
          
          // Update progress callback
          options?.onChunkLoaded?.(assemblyChunk.storageIndex, this.streamingAssembler?.getStats().assembledChunks || 1);
          
          // If this is not the first chunk, seamlessly replace the buffer
          if (assemblyChunk.storageIndex > 0) {
            this.seamlesslyReplaceBuffer(trackId, assemblyChunk);
          }
        },
        onProgress: (assembled, total) => {
          this.onProgressiveLoadingStatus?.('PROGRESS', { 
            trackId, 
            assembled, 
            total,
            strategy: 'separated-instant' 
          });
        }
      });
      
      // Start the download process
      const downloadResult = await this.downloadManager.downloadAudio(url, {
        priorityFirstChunk: true
      });
      
      // Initialize assembler
      this.streamingAssembler.initialize(downloadResult.totalSize);
      
      // Process download chunks as they arrive
      for (const downloadChunk of downloadResult.chunks) {
        this.streamingAssembler.addDownloadChunk(downloadChunk);
      }
      
      // Finalize assembly
      this.streamingAssembler.finalize();
      
      // Complete the loading process
      options?.onFullyLoaded?.();
      this.onProgressiveLoadingStatus?.('COMPLETED', { 
        trackId, 
        totalLoadTime: Date.now() - startTime,
        downloadTime: downloadResult.downloadTime,
        averageSpeed: downloadResult.averageSpeed,
        strategy: 'separated-instant'
      });
      
      console.log(`[WebAudioManager] ✅ Separated instant playback complete: ${downloadResult.downloadTime.toFixed(2)}ms download, ${(downloadResult.averageSpeed / 1024 / 1024).toFixed(2)}MB/s`);
      
    } catch (error) {
      console.error(`[WebAudioManager] Separated instant playback failed: ${error}`);
      this.onProgressiveLoadingStatus?.('FAILED', { trackId, error, strategy: 'separated-instant' });
      
      // Fallback to standard loading
      console.log(`[WebAudioManager] Falling back to standard loading for ${trackId}`);
      return this.loadAndPlay(url, trackId, name);
    }
  }

  /**
   * Start playback with the first assembled chunk
   */
  private async startPlaybackWithChunk(trackId: string, assemblyChunk: AssemblyChunk): Promise<void> {
    try {
      // Decode the assembled chunk data
      const audioBuffer = await this.audioContext!.decodeAudioData(assemblyChunk.data.slice(0));
      
      // Set as current track
      this.currentTrackId = trackId;
      this.audioBuffers.set(trackId, audioBuffer);
      
      // Extract channel data for worklet
      const channelData: Float32Array[] = [];
      for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
        channelData.push(audioBuffer.getChannelData(i));
      }
      
      // Send initial buffer to worklet
      this.audioWorkletNode!.port.postMessage({
        type: 'SET_BUFFER',
        trackId,
        channelData,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
        totalSamples: audioBuffer.length
      });
      
      // Start playback
      this.audioWorkletNode!.port.postMessage({ type: 'PLAY' });
      
      console.log(`[WebAudioManager] 🎵 Started playback with first chunk: ${(assemblyChunk.totalSize / 1024).toFixed(0)}KB, ${audioBuffer.duration.toFixed(2)}s`);
      
    } catch (error) {
      console.error(`[WebAudioManager] Failed to start playback with chunk: ${error}`);
      throw error;
    }
  }

  /**
   * Seamlessly replace the current buffer with a larger one containing more audio data
   */
  private async seamlesslyReplaceBuffer(trackId: string, assemblyChunk: AssemblyChunk): Promise<void> {
    if (this.currentTrackId !== trackId) {
      console.log(`[WebAudioManager] Skipping buffer replacement for inactive track: ${trackId}`);
      return;
    }
    
    try {
      // Get current playback position
      const currentPosition = this.getCurrentTime();
      
      // Decode the complete assembled chunk
      const newAudioBuffer = await this.audioContext!.decodeAudioData(assemblyChunk.data.slice(0));
      
      // Update stored buffer
      this.audioBuffers.set(trackId, newAudioBuffer);
      
      // Extract channel data for worklet
      const channelData: Float32Array[] = [];
      for (let i = 0; i < newAudioBuffer.numberOfChannels; i++) {
        channelData.push(newAudioBuffer.getChannelData(i));
      }
      
      // Send seamless buffer replacement message to worklet
      this.audioWorkletNode!.port.postMessage({
        type: 'REPLACE_BUFFER',
        trackId,
        channelData,
        sampleRate: newAudioBuffer.sampleRate,
        numberOfChannels: newAudioBuffer.numberOfChannels,
        totalSamples: newAudioBuffer.length,
        currentPosition, // Maintain exact playback position
        startTime: Date.now()
      });
      
      if (this.instantPlaybackConfig.enablePerformanceLogging) {
        console.log(`[WebAudioManager] 🔄 Seamlessly replaced buffer: ${(assemblyChunk.totalSize / 1024 / 1024).toFixed(2)}MB, ${newAudioBuffer.duration.toFixed(2)}s (position: ${currentPosition.toFixed(3)}s)`);
      }
      
    } catch (error) {
      console.error(`[WebAudioManager] Failed to replace buffer seamlessly: ${error}`);
      // Continue playback with current buffer - don't fail the whole process
    }
  }

  // Preload audio for smooth transitions
  async preloadAudio(url: string, trackId: string, name: string = 'Unknown'): Promise<void> {
    // Check if already in memory buffer or currently preloading
    if (this.audioBuffers.has(trackId) || this.preloadQueue.has(trackId)) {
      console.log(`[WebAudioManager] Skipping preload for ${trackId}: already loaded or in progress`);
      return;
    }
    
    // Check if already in chunk store
    if (this.chunkStore) {
      const isInChunkStore = await this.chunkStore.isStored(trackId);
      if (isInChunkStore) {
        console.log(`[WebAudioManager] Skipping preload for ${trackId}: already in chunk store`);
        return;
      }
    }
    
    this.preloadQueue.add(trackId);
    
    try {
      console.log(`[WebAudioManager] Preloading: ${name} (${trackId})`);
      
      if (this.chunkStore && this.enableCache) {
        // Store in chunk store for efficient access
        await this.chunkStore.storeAudio(url, trackId, name);
        console.log(`[WebAudioManager] ✅ Preloaded to chunk store: ${name}`);
      } else {
        // Fallback to direct memory loading
        await this.loadAudio(url, trackId);
        console.log(`[WebAudioManager] ✅ Preloaded to memory: ${name}`);
      }
    } catch (error) {
      console.warn(`[WebAudioManager] Failed to preload ${name} (${trackId}):`, error);
    } finally {
      this.preloadQueue.delete(trackId);
    }
  }

  // Control methods
  async pause(): Promise<void> {
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ type: 'PAUSE' });
    }
  }

  async resume(): Promise<void> {
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({ type: 'PLAY' });
    }
  }

  async seek(time: number): Promise<void> {
    if (this.audioWorkletNode) {
      this.audioWorkletNode.port.postMessage({
        type: 'SEEK',
        time
      });
    }
  }

  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  getCurrentTime(): number {
    return this.lastKnownPosition;
  }

  // Determine if instant playback should be used
  private shouldUseInstantPlayback(url: string, forceInstant?: boolean): boolean {
    if (!this.enableInstantPlayback) return false;
    if (forceInstant) return true;
    
    const strategy = this.instantPlaybackConfig.strategy;
    if (strategy === 'never') return false;
    if (strategy === 'always') return true;
    
    // Auto strategy - use instant playback for most scenarios
    // Could be enhanced with network speed detection, file size estimation, etc.
    return true;
  }

  // Load first chunk for instant playback with Range requests
  private async loadFirstChunk(session: InstantPlaybackSession, onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void): Promise<AudioBuffer> {
    const startTime = Date.now();
    const targetInitialSize = this.instantPlaybackConfig.playbackChunkSize || 384 * 1024;
    
    try {
      // First, try Range request for just the initial chunk
      const rangeSupported = await this.checkRangeSupport(session.url);
      
      if (rangeSupported) {
        return await this.loadFirstChunkWithRangeRequest(session, startTime, targetInitialSize, onChunkLoaded);
      } else {
        return await this.loadFirstChunkWithProgressiveDownload(session, startTime, targetInitialSize, onChunkLoaded);
      }
    } catch (error) {
      console.warn(`[WebAudioManager] Range request failed, falling back to progressive download: ${error}`);
      return await this.loadFirstChunkWithProgressiveDownload(session, startTime, targetInitialSize, onChunkLoaded);
    }
  }
  
  // Check if server supports Range requests
  private async checkRangeSupport(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const acceptRanges = response.headers.get('accept-ranges');
      const contentLength = response.headers.get('content-length');
      
      return acceptRanges === 'bytes' && contentLength !== null;
    } catch (error) {
      console.warn(`[WebAudioManager] Range support check failed: ${error}`);
      return false;
    }
  }
  
  // Load first chunk using Range request
  private async loadFirstChunkWithRangeRequest(
    session: InstantPlaybackSession,
    startTime: number,
    targetInitialSize: number,
    onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void
  ): Promise<AudioBuffer> {
    console.log(`[WebAudioManager] Using Range request for initial chunk (${(targetInitialSize / 1024).toFixed(1)}KB)`);
    
    // Request only the initial chunk
    const response = await fetch(session.url, {
      headers: {
        'Range': `bytes=0-${targetInitialSize - 1}`
      }
    });
    
    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch initial chunk: ${response.status}`);
    }
    
    const chunkBuffer = await response.arrayBuffer();
    
    // Try to decode the partial chunk
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.audioContext!.decodeAudioData(chunkBuffer);
    } catch (error) {
      // If partial decode fails, get more data
      console.warn(`[WebAudioManager] Partial decode failed, requesting larger chunk: ${error}`);
      
      const largerSize = targetInitialSize * 2;
      const largerResponse = await fetch(session.url, {
        headers: {
          'Range': `bytes=0-${largerSize - 1}`
        }
      });
      
      if (!largerResponse.ok && largerResponse.status !== 206) {
        throw new Error(`Failed to fetch larger chunk: ${largerResponse.status}`);
      }
      
      const largerBuffer = await largerResponse.arrayBuffer();
      audioBuffer = await this.audioContext!.decodeAudioData(largerBuffer);
    }
    
    const loadTime = Date.now() - startTime;
    console.log(`[WebAudioManager] Initial chunk loaded via Range request in ${loadTime}ms (${(chunkBuffer.byteLength / 1024).toFixed(1)}KB)`);
    
    // Get file size for calculating total chunks
    const fileSize = await this.getFileSize(session.url);
    const estimatedTotalChunks = Math.ceil(fileSize / targetInitialSize);
    
    // Store metadata for session
    session.metadata = {
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      totalSamples: audioBuffer.length
    };
    
    session.loadedChunks.add(0);
    session.audioBuffer = audioBuffer;
    session.totalChunks = estimatedTotalChunks;
    
    // Start loading remaining chunks in background
    this.loadRemainingChunksWithRangeRequests(session, fileSize, targetInitialSize, onChunkLoaded);
    
    onChunkLoaded?.(0, estimatedTotalChunks);
    
    return audioBuffer;
  }
  
  // Load first chunk using progressive download (fallback)
  private async loadFirstChunkWithProgressiveDownload(
    session: InstantPlaybackSession,
    startTime: number,
    targetInitialSize: number,
    onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void
  ): Promise<AudioBuffer> {
    console.log(`[WebAudioManager] Using progressive download for initial chunk`);
    
    const response = await fetch(session.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio file: ${response.status}`);
    }
    
    if (!response.body) {
      throw new Error('ReadableStream not supported');
    }
    
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    
    // Read until we have enough for initial playback
    let hasEnoughForPlayback = false;
    
    while (!hasEnoughForPlayback) {
      const { done, value } = await reader.read();
      
      if (done) {
        hasEnoughForPlayback = true;
        break;
      }
      
      chunks.push(value);
      loaded += value.length;
      
      // Check if we have enough data to start playback
      if (loaded >= targetInitialSize) {
        hasEnoughForPlayback = true;
      }
    }
    
    // Create partial ArrayBuffer for initial decode
    const partialBuffer = new ArrayBuffer(loaded);
    const uint8Array = new Uint8Array(partialBuffer);
    let offset = 0;
    
    for (const chunk of chunks) {
      uint8Array.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Decode the partial audio data
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.audioContext!.decodeAudioData(partialBuffer);
    } catch (error) {
      // If partial decode fails, try to load more data
      console.warn(`[WebAudioManager] Partial decode failed, loading more data: ${error}`);
      
      // Load the rest of the file
      const remainingChunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        remainingChunks.push(value);
        loaded += value.length;
      }
      
      // Create complete buffer
      const completeBuffer = new ArrayBuffer(loaded);
      const completeUint8Array = new Uint8Array(completeBuffer);
      let completeOffset = 0;
      
      // Copy initial chunks
      for (const chunk of chunks) {
        completeUint8Array.set(chunk, completeOffset);
        completeOffset += chunk.length;
      }
      
      // Copy remaining chunks
      for (const chunk of remainingChunks) {
        completeUint8Array.set(chunk, completeOffset);
        completeOffset += chunk.length;
      }
      
      // Decode complete file
      audioBuffer = await this.audioContext!.decodeAudioData(completeBuffer);
    }
    
    const loadTime = Date.now() - startTime;
    console.log(`[WebAudioManager] Initial chunk loaded progressively in ${loadTime}ms (${(loaded / 1024).toFixed(1)}KB)`);
    
    // Store metadata for session
    session.metadata = {
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      totalSamples: audioBuffer.length
    };
    
    session.loadedChunks.add(0);
    session.audioBuffer = audioBuffer;
    session.totalChunks = 1; // For progressive download, we load everything at once
    
    // Start loading remaining data in background if we didn't get everything
    if (loaded < targetInitialSize * 3) { // If we got less than 3x initial size, continue loading
      this.continueLoadingInBackground(session, reader, chunks, loaded, onChunkLoaded);
    }
    
    onChunkLoaded?.(0, 1);
    
    return audioBuffer;
  }
  
  // Get file size
  private async getFileSize(url: string): Promise<number> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const contentLength = response.headers.get('content-length');
      return contentLength ? parseInt(contentLength, 10) : 0;
    } catch (error) {
      console.warn(`[WebAudioManager] Failed to get file size: ${error}`);
      return 0;
    }
  }
  
  // Load remaining chunks using Range requests
  private async loadRemainingChunksWithRangeRequests(
    session: InstantPlaybackSession,
    fileSize: number,
    initialChunkSize: number,
    onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void
  ): Promise<void> {
    if (!session.isActive) return;
    
    const subsequentChunkSize = this.instantPlaybackConfig.storageChunkSize || 2 * 1024 * 1024;
    let currentOffset = initialChunkSize;
    let chunkIndex = 1;
    
    const loadedChunks: AudioBuffer[] = [session.audioBuffer!];
    
    try {
      while (currentOffset < fileSize && session.isActive) {
        const endOffset = Math.min(currentOffset + subsequentChunkSize - 1, fileSize - 1);
        
        console.log(`[WebAudioManager] Loading chunk ${chunkIndex} (${(currentOffset / 1024).toFixed(1)}KB - ${(endOffset / 1024).toFixed(1)}KB)`);
        
        const response = await fetch(session.url, {
          headers: {
            'Range': `bytes=${currentOffset}-${endOffset}`
          }
        });
        
        if (!response.ok && response.status !== 206) {
          throw new Error(`Failed to fetch chunk ${chunkIndex}: ${response.status}`);
        }
        
        const chunkBuffer = await response.arrayBuffer();
        
        // For now, we'll decode the full file up to this point
        // In a more advanced implementation, we'd merge chunks
        const combinedSize = currentOffset + chunkBuffer.byteLength;
        const combinedBuffer = new ArrayBuffer(combinedSize);
        const combinedArray = new Uint8Array(combinedBuffer);
        
        // Copy initial chunk(s)
        const initialResponse = await fetch(session.url, {
          headers: {
            'Range': `bytes=0-${currentOffset + chunkBuffer.byteLength - 1}`
          }
        });
        
        if (initialResponse.ok || initialResponse.status === 206) {
          const initialBuffer = await initialResponse.arrayBuffer();
          combinedArray.set(new Uint8Array(initialBuffer));
          
          // Decode combined buffer
          const combinedAudioBuffer = await this.audioContext!.decodeAudioData(combinedBuffer);
          
          // Replace buffer seamlessly
          if (session.isActive && this.currentTrackId === session.trackId) {
            await this.replaceBufferSeamlessly(session.trackId, combinedAudioBuffer);
            
            // Update session
            session.audioBuffer = combinedAudioBuffer;
            session.metadata = {
              duration: combinedAudioBuffer.duration,
              sampleRate: combinedAudioBuffer.sampleRate,
              numberOfChannels: combinedAudioBuffer.numberOfChannels,
              totalSamples: combinedAudioBuffer.length
            };
            
            session.loadedChunks.add(chunkIndex);
            onChunkLoaded?.(chunkIndex, session.totalChunks);
          }
        }
        
        currentOffset = endOffset + 1;
        chunkIndex++;
        
        // Add small delay to prevent overwhelming the browser
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      console.log(`[WebAudioManager] Completed loading ${chunkIndex - 1} chunks for ${session.trackId}`);
      
    } catch (error) {
      console.warn(`[WebAudioManager] Range request loading failed: ${error}`);
    }
  }
  
  // Continue loading remaining data in background
  private async continueLoadingInBackground(
    session: InstantPlaybackSession,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initialChunks: Uint8Array[],
    initialLoaded: number,
    onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void
  ): Promise<void> {
    try {
      const remainingChunks: Uint8Array[] = [];
      let totalLoaded = initialLoaded;
      
      // Continue reading the stream
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        remainingChunks.push(value);
        totalLoaded += value.length;
        
        // Update session periodically with larger buffer
        if (remainingChunks.length % 5 === 0) { // Every 5 chunks
          await this.updateSessionWithLargerBuffer(session, initialChunks, remainingChunks, totalLoaded);
        }
      }
      
      // Final update with complete buffer
      if (remainingChunks.length > 0) {
        await this.updateSessionWithLargerBuffer(session, initialChunks, remainingChunks, totalLoaded);
      }
      
      console.log(`[WebAudioManager] Background loading completed for ${session.trackId} (${(totalLoaded / 1024 / 1024).toFixed(1)}MB)`);
      
    } catch (error) {
      console.warn(`[WebAudioManager] Background loading failed: ${error}`);
    } finally {
      reader.releaseLock();
    }
  }
  
  // Update session with larger buffer
  private async updateSessionWithLargerBuffer(
    session: InstantPlaybackSession,
    initialChunks: Uint8Array[],
    remainingChunks: Uint8Array[],
    totalLoaded: number
  ): Promise<void> {
    if (!session.isActive) return;
    
    try {
      // Combine all chunks
      const completeBuffer = new ArrayBuffer(totalLoaded);
      const uint8Array = new Uint8Array(completeBuffer);
      let offset = 0;
      
      // Copy initial chunks
      for (const chunk of initialChunks) {
        uint8Array.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Copy remaining chunks
      for (const chunk of remainingChunks) {
        uint8Array.set(chunk, offset);
        offset += chunk.length;
      }
      
      // Decode the larger buffer
      const newAudioBuffer = await this.audioContext!.decodeAudioData(completeBuffer);
      
      // Update session
      session.audioBuffer = newAudioBuffer;
      session.metadata = {
        duration: newAudioBuffer.duration,
        sampleRate: newAudioBuffer.sampleRate,
        numberOfChannels: newAudioBuffer.numberOfChannels,
        totalSamples: newAudioBuffer.length
      };
      
      // Replace buffer seamlessly in worklet
      await this.replaceBufferSeamlessly(session.trackId, newAudioBuffer);
      
    } catch (error) {
      console.warn(`[WebAudioManager] Failed to update with larger buffer: ${error}`);
    }
  }

  // Load remaining chunks in background
  private async loadRemainingChunks(session: InstantPlaybackSession, onChunkLoaded?: (chunkIndex: number, totalChunks: number) => void): Promise<void> {
    // With the current implementation, we load the full file upfront
    // So there are no additional chunks to load
    // This method exists for future optimization where we could implement true streaming
    
    if (!session.isActive) return;
    
    // Since we loaded everything in loadFirstChunk, we're already done
    console.log(`[WebAudioManager] Full audio loaded in initial chunk for ${session.trackId}`);
    
    // No additional work needed
    return;
  }

  // Load a specific chunk
  private async loadChunk(url: string, start: number, end: number): Promise<AudioBuffer> {
    const response = await fetch(url, {
      headers: {
        'Range': `bytes=${start}-${end}`
      }
    });
    
    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to fetch chunk: ${response.status}`);
    }
    
    const chunkBuffer = await response.arrayBuffer();
    return await this.audioContext!.decodeAudioData(chunkBuffer);
  }

  // Merge two audio buffers
  private async mergeAudioBuffers(buffer1: AudioBuffer, buffer2: AudioBuffer): Promise<AudioBuffer> {
    const totalLength = buffer1.length + buffer2.length;
    const mergedBuffer = this.audioContext!.createBuffer(
      buffer1.numberOfChannels,
      totalLength,
      buffer1.sampleRate
    );
    
    // Copy data from both buffers
    for (let channel = 0; channel < buffer1.numberOfChannels; channel++) {
      const mergedChannelData = mergedBuffer.getChannelData(channel);
      const buffer1Data = buffer1.getChannelData(channel);
      const buffer2Data = buffer2.getChannelData(channel);
      
      // Copy first buffer
      mergedChannelData.set(buffer1Data, 0);
      
      // Copy second buffer
      mergedChannelData.set(buffer2Data, buffer1.length);
    }
    
    return mergedBuffer;
  }

  // Replace buffer seamlessly in worklet
  private async replaceBufferSeamlessly(trackId: string, newBuffer: AudioBuffer): Promise<void> {
    if (!this.audioWorkletNode || this.currentTrackId !== trackId) {
      return;
    }
    
    // Get current position from worklet
    const currentPosition = await this.getCurrentPosition();
    
    // Extract channel data
    const channelData: Float32Array[] = [];
    for (let i = 0; i < newBuffer.numberOfChannels; i++) {
      channelData.push(newBuffer.getChannelData(i));
    }
    
    // Send replace buffer message
    this.audioWorkletNode.port.postMessage({
      type: 'REPLACE_BUFFER',
      trackId,
      channelData,
      sampleRate: newBuffer.sampleRate,
      numberOfChannels: newBuffer.numberOfChannels,
      totalSamples: newBuffer.length,
      currentPosition: currentPosition.currentTime,
      startTime: Date.now()
    });
    
    // Update cached buffer
    this.audioBuffers.set(trackId, newBuffer);
  }

  // Get current position from worklet
  private async getCurrentPosition(): Promise<{ currentTime: number; samplePosition: number }> {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).substr(2, 9);
      
      // Set up resolver
      this.positionRequestResolvers.set(requestId, resolve);
      
      // Request position
      this.audioWorkletNode!.port.postMessage({
        type: 'GET_CURRENT_POSITION',
        requestId
      });
      
      // Timeout after 100ms
      setTimeout(() => {
        if (this.positionRequestResolvers.has(requestId)) {
          this.positionRequestResolvers.delete(requestId);
          resolve({ currentTime: this.lastKnownPosition, samplePosition: 0 });
        }
      }, 100);
    });
  }
  
  // Get instant playback performance metrics
  getInstantPlaybackMetrics(): {
    enabled: boolean;
    config: InstantPlaybackConfig;
    activeSessions: number;
    sessionMetrics: Array<{
      trackId: string;
      startTime: number;
      isActive: boolean;
      loadedChunks: number;
      totalChunks: number;
    }>;
  } {
    const sessionMetrics = Array.from(this.instantPlaybackSessions.values()).map(session => ({
      trackId: session.trackId,
      startTime: session.startTime,
      isActive: session.isActive,
      loadedChunks: session.loadedChunks.size,
      totalChunks: session.totalChunks
    }));
    
    return {
      enabled: this.enableInstantPlayback,
      config: this.instantPlaybackConfig,
      activeSessions: sessionMetrics.filter(s => s.isActive).length,
      sessionMetrics
    };
  }
  
  // Get performance strategy recommendation
  getPlaybackStrategy(url: string, options?: {
    estimatedFileSize?: number;
    connectionSpeed?: 'slow' | 'medium' | 'fast';
    deviceType?: 'mobile' | 'desktop';
  }): {
    strategy: 'instant' | 'progressive' | 'standard';
    reasoning: string;
    recommendedConfig?: Partial<InstantPlaybackConfig>;
  } {
    // Default to auto strategy if enabled
    if (!this.enableInstantPlayback) {
      return {
        strategy: 'standard',
        reasoning: 'Instant playback is disabled'
      };
    }
    
    const config = this.instantPlaybackConfig;
    const deviceType = options?.deviceType || (this.iosSafariDetected ? 'mobile' : 'desktop');
    const connectionSpeed = options?.connectionSpeed || 'medium';
    const estimatedFileSize = options?.estimatedFileSize || 5 * 1024 * 1024; // 5MB default
    
    // iOS Safari specific recommendations
    if (this.iosSafariDetected) {
      if (estimatedFileSize > 10 * 1024 * 1024) { // > 10MB
        return {
          strategy: 'instant',
          reasoning: 'Large file on iOS Safari - instant playback recommended to prevent memory issues',
          recommendedConfig: {
            playbackChunkSize: 256 * 1024, // 256KB for iOS
            storageChunkSize: 1024 * 1024, // 1MB for iOS
            maxInitialWaitTime: 800 // Longer timeout for iOS
          }
        };
      }
    }
    
    // Connection speed based recommendations
    if (connectionSpeed === 'slow') {
      return {
        strategy: 'instant',
        reasoning: 'Slow connection detected - instant playback will provide better user experience',
        recommendedConfig: {
          playbackChunkSize: 192 * 1024, // Smaller initial chunk for slow connections
          storageChunkSize: 512 * 1024,
          maxInitialWaitTime: 1000
        }
      };
    }
    
    if (connectionSpeed === 'fast' && estimatedFileSize < 2 * 1024 * 1024) {
      return {
        strategy: 'standard',
        reasoning: 'Fast connection and small file - standard loading will be quick enough'
      };
    }
    
    // Default to instant for most scenarios
    return {
      strategy: 'instant',
      reasoning: 'Optimal balance of performance and user experience',
      recommendedConfig: config
    };
  }
  
  // Enable instant playback mode with configuration
  enableInstantMode(config?: Partial<InstantPlaybackConfig>): void {
    this.enableInstantPlayback = true;
    if (config) {
      this.instantPlaybackConfig = { ...this.instantPlaybackConfig, ...config };
      
      // Apply iOS Safari optimizations if needed
      if (this.iosSafariDetected) {
        if (this.instantPlaybackConfig.playbackChunkSize) {
          this.instantPlaybackConfig.playbackChunkSize = Math.min(
            this.instantPlaybackConfig.playbackChunkSize,
            256 * 1024
          );
        }
        if (this.instantPlaybackConfig.storageChunkSize) {
          this.instantPlaybackConfig.storageChunkSize = Math.min(
            this.instantPlaybackConfig.storageChunkSize,
            1024 * 1024
          );
        }
      }
    }
    
    console.log(`[WebAudioManager] Instant playback mode enabled with config:`, this.instantPlaybackConfig);
  }
  
  // Disable instant playback mode
  disableInstantMode(): void {
    this.enableInstantPlayback = false;
    
    // Clean up any active sessions
    for (const session of this.instantPlaybackSessions.values()) {
      session.isActive = false;
    }
    this.instantPlaybackSessions.clear();
    
    console.log(`[WebAudioManager] Instant playback mode disabled`);
  }

  // Cleanup
  async cleanup(): Promise<void> {
    if (this.sampleRateMonitorInterval) {
      clearInterval(this.sampleRateMonitorInterval);
      this.sampleRateMonitorInterval = null;
    }

    // Cleanup instant playback sessions
    for (const session of this.instantPlaybackSessions.values()) {
      session.isActive = false;
    }
    this.instantPlaybackSessions.clear();

    if (this.chunkStore) {
      await this.chunkStore.cleanup();
    }

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }

    this.audioBuffers.clear();
    this.isInitialized = false;
  }
}

// Singleton instance for easy use
let globalWebAudioManager: WebAudioManager | null = null;

export function getWebAudioManager(options?: WebAudioManagerOptions): WebAudioManager {
  if (!globalWebAudioManager) {
    globalWebAudioManager = new WebAudioManager(options);
  }
  return globalWebAudioManager;
}