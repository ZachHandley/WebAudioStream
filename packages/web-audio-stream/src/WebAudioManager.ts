// WebAudioManager.ts
// iOS Safari-safe Web Audio manager with progressive streaming and memory management
// Fixes pitch/speed issues and prevents page reloads on iOS Safari

import { AudioChunkStore, type ProgressCallback } from './AudioChunkStore.js';

export interface WebAudioManagerOptions {
  workletPath?: string;
  enableCache?: boolean;
  maxCacheSize?: number;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
  onProgressiveLoadingStatus?: (status: 'STARTED' | 'PROGRESS' | 'COMPLETED' | 'FAILED', data?: any) => void;
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
  
  // Configuration
  private workletPath: string;
  private enableCache: boolean;

  constructor(options: WebAudioManagerOptions = {}) {
    this.workletPath = options.workletPath || '/audio-worklet-processor.js';
    this.enableCache = options.enableCache !== false;
    this.onTimeUpdate = options.onTimeUpdate;
    this.onEnded = options.onEnded;
    this.onError = options.onError;
    this.onProgressiveLoadingStatus = options.onProgressiveLoadingStatus;
    
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

  // Cleanup
  async cleanup(): Promise<void> {
    if (this.sampleRateMonitorInterval) {
      clearInterval(this.sampleRateMonitorInterval);
      this.sampleRateMonitorInterval = null;
    }

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