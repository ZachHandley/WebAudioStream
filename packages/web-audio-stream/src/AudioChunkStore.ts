// AudioChunkStore.ts
// TypeScript implementation of chunk-based audio storage for iOS Safari compatibility
// Provides progressive loading, security, and offline capabilities with iOS-specific optimizations

export interface AudioMetadata {
  trackId: string;
  name: string;
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  totalChunks: number;
  lastAccessed: number;
  fileSize: number;
  url: string;
}

export interface AudioChunk {
  id: string;
  trackId: string;
  chunkIndex: number;
  sampleRate: number;
  length: number;
  channels: Float32Array[];
}

export interface StoredChunk {
  id: string;
  trackId: string;
  chunkIndex: number;
  sampleRate: number;
  length: number;
  channels: string[]; // Encoded as strings for IndexedDB
}

export interface ProgressCallback {
  (loaded: number, total: number, canStartPlayback: boolean): void;
}

export interface InstantChunkConfig {
  initialChunkSize: number;
  subsequentChunkSize: number;
  enableInstantMode: boolean;
}

/**
 * iOS Safari-safe audio chunk storage with progressive loading
 * 
 * Key features:
 * - Memory-safe chunk sizing to prevent iOS page reloads
 * - Safari-specific IndexedDB retry logic
 * - Progressive audio loading for instant playback
 * - Automatic cleanup and storage management
 * - Simple obfuscation for privacy
 */
export class AudioChunkStore {
  private db: IDBDatabase | null = null;
  private audioContext: AudioContext;
  private chunkSizeBytes: number = 3 * 1024 * 1024; // 3MB per chunk (default)
  private initialized = false;
  private readonly dbName = 'WAS_MediaCache_v1';
  private readonly dbVersion = 2;
  
  // Instant playback chunk configuration
  private instantChunkConfig: InstantChunkConfig = {
    initialChunkSize: 384 * 1024, // 384KB for instant playback
    subsequentChunkSize: 2 * 1024 * 1024, // 2MB for subsequent chunks
    enableInstantMode: true
  };
  
  // Simple obfuscation key (not for real security, just to deter casual inspection)
  private readonly obfuscationKey = 'WebAudioStream2024';
  
  // Storage limits
  private readonly maxStorageSize = 1024 * 1024 * 1024; // 1GB
  private readonly maxAge = 10 * 24 * 60 * 60 * 1000; // 10 days
  private readonly minChunksForPlayback = 1; // Start playback after 1 chunk (3MB loads quickly)

  constructor(audioContext: AudioContext, instantConfig?: Partial<InstantChunkConfig>) {
    this.audioContext = audioContext;
    
    if (instantConfig) {
      this.instantChunkConfig = { ...this.instantChunkConfig, ...instantConfig };
    }
  }

  // Simple XOR-based obfuscation for metadata (reversible)
  private obfuscateString(input: string): string {
    let result = '';
    for (let i = 0; i < input.length; i++) {
      const charCode = input.charCodeAt(i);
      const keyChar = this.obfuscationKey.charCodeAt(i % this.obfuscationKey.length);
      result += String.fromCharCode(charCode ^ keyChar);
    }
    // Base64 encode to make it look more scrambled
    return btoa(result);
  }

  private deobfuscateString(input: string): string {
    try {
      // Base64 decode first
      const decoded = atob(input);
      let result = '';
      for (let i = 0; i < decoded.length; i++) {
        const charCode = decoded.charCodeAt(i);
        const keyChar = this.obfuscationKey.charCodeAt(i % this.obfuscationKey.length);
        result += String.fromCharCode(charCode ^ keyChar);
      }
      return result;
    } catch (error) {
      console.warn('[AudioChunkStore] Failed to deobfuscate string:', error);
      return input; // Return original if deobfuscation fails
    }
  }

  // Obfuscate sensitive metadata fields
  private obfuscateMetadata(metadata: AudioMetadata): any {
    return {
      ...metadata,
      name: this.obfuscateString(metadata.name),
      url: this.obfuscateString(metadata.url),
      // Keep technical fields unobfuscated for functionality
      trackId: metadata.trackId,
      duration: metadata.duration,
      sampleRate: metadata.sampleRate,
      numberOfChannels: metadata.numberOfChannels,
      totalChunks: metadata.totalChunks,
      lastAccessed: metadata.lastAccessed,
      fileSize: metadata.fileSize,
      _obfuscated: true // Flag to indicate this is obfuscated
    };
  }

  // Deobfuscate metadata when reading
  private deobfuscateMetadata(obfuscatedData: any): AudioMetadata {
    if (!obfuscatedData._obfuscated) {
      // Already deobfuscated or old format
      return obfuscatedData as AudioMetadata;
    }

    return {
      ...obfuscatedData,
      name: this.deobfuscateString(obfuscatedData.name),
      url: this.deobfuscateString(obfuscatedData.url)
    };
  }

  // Safari iOS detection
  private isSafariIOS(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent);
  }

  // Promise timeout utility for Safari IndexedDB operations
  private withTimeout<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Safari IndexedDB operation timeout')), timeoutMs)
      )
    ]);
  }

  // Safari-safe IndexedDB database opening with retry logic
  private openDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        console.log('[AudioChunkStore] Database initialized');
        
        // Run cleanup on startup
        this.cleanup().catch(console.warn);
        
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // Create object stores with obfuscated names
        if (!db.objectStoreNames.contains('cache_meta')) {
          const metadataStore = db.createObjectStore('cache_meta', { keyPath: 'trackId' });
          metadataStore.createIndex('lastAccessed', 'lastAccessed');
          metadataStore.createIndex('url', 'url');
        }
        
        if (!db.objectStoreNames.contains('cache_data')) {
          const chunksStore = db.createObjectStore('cache_data', { keyPath: 'id' });
          chunksStore.createIndex('trackId', 'trackId');
          chunksStore.createIndex('chunkIndex', 'chunkIndex');
        }
        
        console.log('[AudioChunkStore] Database schema created');
      };
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Apply Safari iOS workarounds
    if (this.isSafariIOS()) {
      console.log('[AudioChunkStore] Safari iOS detected, applying workarounds');
      // Reduce chunk size for Safari iOS memory constraints
      this.chunkSizeBytes = 1 * 1024 * 1024; // 1MB instead of 3MB for Safari
    }

    // Safari iOS fix: IndexedDB fails 100% of the time on first try since iOS 14.6
    const maxRetries = this.isSafariIOS() ? 3 : 1;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        console.log(`[AudioChunkStore] Attempting to open IndexedDB (attempt ${retryCount + 1}/${maxRetries})`);
        
        // Add timeout protection for Safari
        await this.withTimeout(this.openDatabase(), 10000);
        
        console.log('[AudioChunkStore] IndexedDB opened successfully');
        return;
        
      } catch (error) {
        retryCount++;
        console.warn(`[AudioChunkStore] IndexedDB open attempt ${retryCount} failed:`, error);
        
        if (retryCount >= maxRetries) {
          console.error('[AudioChunkStore] All IndexedDB connection attempts failed');
          throw new Error(`Safari IndexedDB failed after ${maxRetries} retries: ${error}`);
        }
        
        // Wait between retries (longer for Safari iOS)
        const retryDelay = this.isSafariIOS() ? 1000 : 500;
        console.log(`[AudioChunkStore] Waiting ${retryDelay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  // Store audio file in chunks with progressive loading
  async storeAudio(
    url: string, 
    trackId: string, 
    name: string,
    progressCallback?: ProgressCallback
  ): Promise<AudioMetadata> {
    if (!this.initialized) await this.initialize();

    // Check if already stored
    const existingMetadata = await this.getMetadata(trackId);
    if (existingMetadata) {
      // Update last accessed time
      await this.updateLastAccessed(trackId);
      return existingMetadata;
    }

    console.log(`[AudioChunkStore] Storing audio: ${name} (${trackId})`);

    // Fetch and decode audio
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    // Create metadata - calculate chunks based on size, not time
    const bytesPerSample = 4; // 32-bit float
    const totalBytes = audioBuffer.length * audioBuffer.numberOfChannels * bytesPerSample;
    const totalChunks = Math.ceil(totalBytes / this.chunkSizeBytes);
    
    const metadata: AudioMetadata = {
      trackId,
      name,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      totalChunks,
      lastAccessed: Date.now(),
      fileSize: arrayBuffer.byteLength,
      url
    };

    // Store metadata first
    await this.saveMetadata(metadata);

    // Convert to chunks and store progressively
    const chunks = this.audioBufferToChunks(audioBuffer, trackId);
    
    for (let i = 0; i < chunks.length; i++) {
      await this.saveChunk(chunks[i]);
      
      // Report progress
      if (progressCallback) {
        const loaded = i + 1;
        const canStartPlayback = loaded >= this.minChunksForPlayback;
        progressCallback(loaded, totalChunks, canStartPlayback);
      }
    }

    console.log(`[AudioChunkStore] Stored ${chunks.length} chunks for ${name}`);
    return metadata;
  }

  // Get audio buffer for playback (can be partial)
  async getAudioBuffer(
    trackId: string, 
    startChunk: number = 0, 
    chunkCount?: number
  ): Promise<AudioBuffer | null> {
    if (!this.initialized) await this.initialize();

    const metadata = await this.getMetadata(trackId);
    if (!metadata) return null;

    // Update last accessed
    await this.updateLastAccessed(trackId);

    // Determine chunks to load
    const endChunk = chunkCount 
      ? Math.min(startChunk + chunkCount, metadata.totalChunks)
      : metadata.totalChunks;

    // Load chunks
    const chunks: AudioChunk[] = [];
    for (let i = startChunk; i < endChunk; i++) {
      const chunk = await this.getChunk(trackId, i);
      if (chunk) chunks.push(chunk);
    }

    if (chunks.length === 0) return null;

    // Merge chunks into AudioBuffer
    return this.mergeChunks(chunks, metadata);
  }

  // Check if track is stored (any chunks)
  async isStored(trackId: string): Promise<boolean> {
    if (!this.initialized) await this.initialize();
    
    const metadata = await this.getMetadata(trackId);
    return !!metadata;
  }

  // Get available chunks for a track
  async getAvailableChunks(trackId: string): Promise<number[]> {
    if (!this.initialized) await this.initialize();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_data'], 'readonly');
      const store = transaction.objectStore('cache_data');
      const index = store.index('trackId');
      const request = index.getAll(trackId);

      request.onsuccess = () => {
        const chunks = request.result as StoredChunk[];
        const availableChunks = chunks.map(chunk => chunk.chunkIndex).sort((a, b) => a - b);
        resolve(availableChunks);
      };

      request.onerror = () => reject(request.error);
    });
  }

  private audioBufferToChunks(audioBuffer: AudioBuffer, trackId: string): AudioChunk[] {
    const bytesPerSample = 4; // 32-bit float
    const samplesPerChunk = Math.floor(this.chunkSizeBytes / (audioBuffer.numberOfChannels * bytesPerSample));
    const totalSamples = audioBuffer.length;
    const chunks: AudioChunk[] = [];

    for (let offset = 0; offset < totalSamples; offset += samplesPerChunk) {
      const length = Math.min(samplesPerChunk, totalSamples - offset);
      const chunkIndex = Math.floor(offset / samplesPerChunk);
      
      const channels: Float32Array[] = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const channelData = audioBuffer.getChannelData(c);
        const chunkData = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          chunkData[i] = channelData[offset + i];
        }
        channels.push(chunkData);
      }

      chunks.push({
        id: `${trackId}-${chunkIndex}`,
        trackId,
        chunkIndex,
        sampleRate: audioBuffer.sampleRate,
        length,
        channels
      });
    }

    console.log(`[AudioChunkStore] Created ${chunks.length} size-based chunks (${Math.round(this.chunkSizeBytes / 1024 / 1024)}MB each) for ${trackId}`);
    return chunks;
  }

  private mergeChunks(chunks: AudioChunk[], metadata: AudioMetadata): AudioBuffer {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const audioBuffer = this.audioContext.createBuffer(
      metadata.numberOfChannels,
      totalLength,
      metadata.sampleRate
    );

    let offset = 0;
    for (const chunk of chunks) {
      for (let c = 0; c < metadata.numberOfChannels; c++) {
        const targetChannel = audioBuffer.getChannelData(c);
        const sourceChannel = chunk.channels[c];
        targetChannel.set(sourceChannel, offset);
      }
      offset += chunk.length;
    }

    return audioBuffer;
  }

  private float32ArrayToString(f32: Float32Array): string {
    const u16 = new Uint16Array(f32.buffer, f32.byteOffset, f32.byteLength / 2);
    
    if ('TextDecoder' in window) {
      const decoder = new TextDecoder('utf-16');
      return decoder.decode(u16);
    }

    let str = '';
    for (let i = 0; i < u16.length; i += 10000) {
      const end = Math.min(i + 10000, u16.length);
      str += String.fromCharCode.apply(null, Array.from(u16.subarray(i, end)));
    }
    return str;
  }

  private stringToFloat32Array(str: string): Float32Array {
    const u16 = new Uint16Array(str.length);
    for (let i = 0; i < str.length; i++) {
      u16[i] = str.charCodeAt(i);
    }
    return new Float32Array(u16.buffer);
  }

  // Database operations
  private async saveMetadata(metadata: AudioMetadata): Promise<void> {
    const obfuscatedMetadata = this.obfuscateMetadata(metadata);
    
    const operation = new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_meta'], 'readwrite');
      const store = transaction.objectStore('cache_meta');
      const request = store.put(obfuscatedMetadata);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    // Add timeout protection for Safari
    return this.withTimeout(operation, 5000);
  }

  async getMetadata(trackId: string): Promise<AudioMetadata | null> {
    const operation = new Promise<AudioMetadata | null>((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_meta'], 'readonly');
      const store = transaction.objectStore('cache_meta');
      const request = store.get(trackId);

      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          const deobfuscated = this.deobfuscateMetadata(result);
          resolve(deobfuscated);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });

    // Add timeout protection for Safari
    return this.withTimeout(operation, 5000);
  }

  private async updateLastAccessed(trackId: string): Promise<void> {
    const metadata = await this.getMetadata(trackId);
    if (metadata) {
      metadata.lastAccessed = Date.now();
      await this.saveMetadata(metadata);
    }
  }

  private async saveChunk(chunk: AudioChunk): Promise<void> {
    const storedChunk: StoredChunk = {
      ...chunk,
      channels: chunk.channels.map(channel => this.float32ArrayToString(channel))
    };

    const operation = new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_data'], 'readwrite');
      const store = transaction.objectStore('cache_data');
      const request = store.put(storedChunk);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    // Add timeout protection for Safari
    return this.withTimeout(operation, 5000);
  }

  private async getChunk(trackId: string, chunkIndex: number): Promise<AudioChunk | null> {
    const id = `${trackId}-${chunkIndex}`;
    
    const operation = new Promise<AudioChunk | null>((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_data'], 'readonly');
      const store = transaction.objectStore('cache_data');
      const request = store.get(id);

      request.onsuccess = () => {
        const storedChunk = request.result as StoredChunk;
        if (!storedChunk) {
          resolve(null);
          return;
        }

        const chunk: AudioChunk = {
          ...storedChunk,
          channels: storedChunk.channels.map(channelStr => this.stringToFloat32Array(channelStr))
        };
        resolve(chunk);
      };

      request.onerror = () => reject(request.error);
    });

    // Add timeout protection for Safari
    return this.withTimeout(operation, 5000);
  }

  // Cleanup operations
  async cleanup(): Promise<void> {
    if (!this.initialized) await this.initialize();

    console.log('[AudioChunkStore] Running cleanup...');

    // Get all metadata
    const allMetadata = await this.getAllMetadata();
    const now = Date.now();
    let totalSize = 0;
    
    // Calculate total storage size
    for (const metadata of allMetadata) {
      totalSize += metadata.fileSize;
    }

    // Remove old tracks
    const tracksToRemove: string[] = [];
    for (const metadata of allMetadata) {
      const age = now - metadata.lastAccessed;
      if (age > this.maxAge) {
        tracksToRemove.push(metadata.trackId);
        totalSize -= metadata.fileSize;
      }
    }

    // Remove tracks if over size limit (oldest first)
    if (totalSize > this.maxStorageSize) {
      const sortedByAge = allMetadata
        .filter(m => !tracksToRemove.includes(m.trackId))
        .sort((a, b) => a.lastAccessed - b.lastAccessed);

      for (const metadata of sortedByAge) {
        if (totalSize <= this.maxStorageSize) break;
        tracksToRemove.push(metadata.trackId);
        totalSize -= metadata.fileSize;
      }
    }

    // Remove selected tracks
    for (const trackId of tracksToRemove) {
      await this.removeTrack(trackId);
    }

    if (tracksToRemove.length > 0) {
      console.log(`[AudioChunkStore] Cleaned up ${tracksToRemove.length} tracks`);
    }
  }

  private async getAllMetadata(): Promise<AudioMetadata[]> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_meta'], 'readonly');
      const store = transaction.objectStore('cache_meta');
      const request = store.getAll();

      request.onsuccess = () => {
        const results = request.result.map((item: any) => this.deobfuscateMetadata(item));
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async removeTrack(trackId: string): Promise<void> {
    if (!this.initialized) await this.initialize();

    // Remove metadata
    await new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_meta'], 'readwrite');
      const store = transaction.objectStore('cache_meta');
      const request = store.delete(trackId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    // Remove all chunks for this track
    await new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction(['cache_data'], 'readwrite');
      const store = transaction.objectStore('cache_data');
      const index = store.index('trackId');
      const request = index.openKeyCursor(IDBKeyRange.only(trackId));

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest).result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };

      request.onerror = () => reject(request.error);
    });

    console.log(`[AudioChunkStore] Removed track: ${trackId}`);
  }

  // Store audio with instant playback support (variable chunk sizes)
  async storeAudioForInstantPlayback(
    url: string,
    trackId: string,
    name: string,
    progressCallback?: ProgressCallback
  ): Promise<AudioMetadata> {
    if (!this.initialized) await this.initialize();

    // Check if already stored
    const existingMetadata = await this.getMetadata(trackId);
    if (existingMetadata) {
      await this.updateLastAccessed(trackId);
      return existingMetadata;
    }

    console.log(`[AudioChunkStore] Storing audio for instant playback: ${name} (${trackId})`);

    // Fetch and decode audio
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    // Create chunks with variable sizes for instant playback
    const chunks = this.audioBufferToInstantChunks(audioBuffer, trackId);
    
    const metadata: AudioMetadata = {
      trackId,
      name,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      totalChunks: chunks.length,
      lastAccessed: Date.now(),
      fileSize: arrayBuffer.byteLength,
      url
    };

    // Store metadata first
    await this.saveMetadata(metadata);

    // Store chunks progressively - first chunk has priority
    for (let i = 0; i < chunks.length; i++) {
      await this.saveChunk(chunks[i]);
      
      // Report progress
      if (progressCallback) {
        const loaded = i + 1;
        const canStartPlayback = loaded >= 1; // Can start after first chunk
        progressCallback(loaded, chunks.length, canStartPlayback);
      }
    }

    console.log(`[AudioChunkStore] Stored ${chunks.length} variable-size chunks for instant playback: ${name}`);
    return metadata;
  }

  // Convert audio buffer to variable-sized chunks for instant playback
  private audioBufferToInstantChunks(audioBuffer: AudioBuffer, trackId: string): AudioChunk[] {
    const chunks: AudioChunk[] = [];
    const bytesPerSample = 4; // 32-bit float
    const totalSamples = audioBuffer.length;
    
    // Calculate chunk sizes in samples
    const initialChunkSamples = Math.floor(
      this.instantChunkConfig.initialChunkSize / (audioBuffer.numberOfChannels * bytesPerSample)
    );
    const subsequentChunkSamples = Math.floor(
      this.instantChunkConfig.subsequentChunkSize / (audioBuffer.numberOfChannels * bytesPerSample)
    );
    
    let offset = 0;
    let chunkIndex = 0;
    
    while (offset < totalSamples) {
      // Use smaller chunk size for first chunk, larger for subsequent
      const chunkSamples = chunkIndex === 0 ? initialChunkSamples : subsequentChunkSamples;
      const length = Math.min(chunkSamples, totalSamples - offset);
      
      const channels: Float32Array[] = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const channelData = audioBuffer.getChannelData(c);
        const chunkData = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          chunkData[i] = channelData[offset + i];
        }
        channels.push(chunkData);
      }

      chunks.push({
        id: `${trackId}-${chunkIndex}`,
        trackId,
        chunkIndex,
        sampleRate: audioBuffer.sampleRate,
        length,
        channels
      });
      
      offset += length;
      chunkIndex++;
    }

    const initialSizeKB = Math.round(this.instantChunkConfig.initialChunkSize / 1024);
    const subsequentSizeKB = Math.round(this.instantChunkConfig.subsequentChunkSize / 1024);
    
    console.log(`[AudioChunkStore] Created ${chunks.length} instant chunks for ${trackId}: first chunk ${initialSizeKB}KB, subsequent ${subsequentSizeKB}KB`);
    return chunks;
  }

  // Load first chunk only for instant playback
  async getFirstChunk(trackId: string): Promise<AudioBuffer | null> {
    if (!this.initialized) await this.initialize();

    const metadata = await this.getMetadata(trackId);
    if (!metadata) return null;

    // Load only the first chunk
    const firstChunk = await this.getChunk(trackId, 0);
    if (!firstChunk) return null;

    // Create buffer from first chunk only
    const audioBuffer = this.audioContext.createBuffer(
      metadata.numberOfChannels,
      firstChunk.length,
      metadata.sampleRate
    );

    for (let c = 0; c < metadata.numberOfChannels; c++) {
      const targetChannel = audioBuffer.getChannelData(c);
      const sourceChannel = firstChunk.channels[c];
      targetChannel.set(sourceChannel, 0);
    }

    await this.updateLastAccessed(trackId);
    return audioBuffer;
  }

  // Get progressive chunks for seamless replacement
  async getProgressiveChunks(
    trackId: string,
    startChunk: number = 0,
    maxChunks?: number
  ): Promise<AudioBuffer | null> {
    if (!this.initialized) await this.initialize();

    const metadata = await this.getMetadata(trackId);
    if (!metadata) return null;

    const endChunk = maxChunks 
      ? Math.min(startChunk + maxChunks, metadata.totalChunks)
      : metadata.totalChunks;

    // Load chunks
    const chunks: AudioChunk[] = [];
    for (let i = startChunk; i < endChunk; i++) {
      const chunk = await this.getChunk(trackId, i);
      if (chunk) chunks.push(chunk);
    }

    if (chunks.length === 0) return null;

    // Merge chunks into single AudioBuffer
    return this.mergeChunks(chunks, metadata);
  }

  // Configure instant playback settings
  configureInstantMode(config: Partial<InstantChunkConfig>): void {
    this.instantChunkConfig = { ...this.instantChunkConfig, ...config };
    
    // Update iOS Safari optimization if needed
    if (this.isSafariIOS()) {
      this.instantChunkConfig.initialChunkSize = Math.min(
        this.instantChunkConfig.initialChunkSize,
        256 * 1024 // Cap at 256KB for iOS Safari
      );
      this.instantChunkConfig.subsequentChunkSize = Math.min(
        this.instantChunkConfig.subsequentChunkSize,
        1024 * 1024 // Cap at 1MB for iOS Safari
      );
    }
    
    console.log(`[AudioChunkStore] Instant mode configured: initial=${Math.round(this.instantChunkConfig.initialChunkSize/1024)}KB, subsequent=${Math.round(this.instantChunkConfig.subsequentChunkSize/1024)}KB`);
  }
  
  // Store audio with streaming support for instant playback
  async storeAudioStreaming(
    url: string,
    trackId: string,
    name: string,
    options: {
      initialChunkSize?: number;
      subsequentChunkSize?: number;
      useRangeRequests?: boolean;
      progressCallback?: ProgressCallback;
    } = {}
  ): Promise<AudioMetadata> {
    if (!this.initialized) await this.initialize();

    // Check if already stored
    const existingMetadata = await this.getMetadata(trackId);
    if (existingMetadata) {
      await this.updateLastAccessed(trackId);
      return existingMetadata;
    }

    console.log(`[AudioChunkStore] Storing audio with streaming: ${name} (${trackId})`);
    
    const initialChunkSize = options.initialChunkSize || this.instantChunkConfig.initialChunkSize;
    const subsequentChunkSize = options.subsequentChunkSize || this.instantChunkConfig.subsequentChunkSize;
    const useRangeRequests = options.useRangeRequests !== false; // Default to true
    
    try {
      // Try streaming approach first
      if (useRangeRequests && await this.checkRangeSupport(url)) {
        return await this.storeAudioWithRangeRequests(url, trackId, name, initialChunkSize, subsequentChunkSize, options.progressCallback);
      } else {
        // Fallback to standard progressive loading
        console.log(`[AudioChunkStore] Range requests not supported, using progressive loading`);
        return await this.storeAudioForInstantPlayback(url, trackId, name, options.progressCallback);
      }
    } catch (error) {
      console.warn(`[AudioChunkStore] Streaming storage failed, falling back to standard method: ${error}`);
      return await this.storeAudio(url, trackId, name, options.progressCallback);
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
      console.warn(`[AudioChunkStore] Range support check failed: ${error}`);
      return false;
    }
  }
  
  // Store audio using Range requests for better streaming
  private async storeAudioWithRangeRequests(
    url: string,
    trackId: string,
    name: string,
    initialChunkSize: number,
    subsequentChunkSize: number,
    progressCallback?: ProgressCallback
  ): Promise<AudioMetadata> {
    // Get file size first
    const fileSize = await this.getFileSize(url);
    if (!fileSize) {
      throw new Error('Could not determine file size');
    }
    
    console.log(`[AudioChunkStore] Using Range requests for ${name} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);
    
    // Load initial chunk
    const initialResponse = await fetch(url, {
      headers: {
        'Range': `bytes=0-${initialChunkSize - 1}`
      }
    });
    
    if (!initialResponse.ok && initialResponse.status !== 206) {
      throw new Error(`Failed to fetch initial chunk: ${initialResponse.status}`);
    }
    
    const initialBuffer = await initialResponse.arrayBuffer();
    const initialAudioBuffer = await this.audioContext.decodeAudioData(initialBuffer);
    
    // Create preliminary metadata
    const totalChunks = Math.ceil(fileSize / subsequentChunkSize);
    const metadata: AudioMetadata = {
      trackId,
      name,
      duration: initialAudioBuffer.duration,
      sampleRate: initialAudioBuffer.sampleRate,
      numberOfChannels: initialAudioBuffer.numberOfChannels,
      totalChunks,
      lastAccessed: Date.now(),
      fileSize,
      url
    };
    
    // Store metadata first
    await this.saveMetadata(metadata);
    
    // Store initial chunk
    const initialChunk = this.audioBufferToSingleChunk(initialAudioBuffer, trackId, 0);
    await this.saveChunk(initialChunk);
    
    // Report initial progress
    progressCallback?.(1, totalChunks, true); // Can start playback
    
    // Load remaining chunks in background
    this.loadRemainingChunksInBackground(url, trackId, initialChunkSize, subsequentChunkSize, fileSize, progressCallback);
    
    return metadata;
  }
  
  // Get file size using HEAD request
  private async getFileSize(url: string): Promise<number> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      const contentLength = response.headers.get('content-length');
      return contentLength ? parseInt(contentLength, 10) : 0;
    } catch (error) {
      console.warn(`[AudioChunkStore] Failed to get file size: ${error}`);
      return 0;
    }
  }
  
  // Convert single AudioBuffer to chunk
  private audioBufferToSingleChunk(audioBuffer: AudioBuffer, trackId: string, chunkIndex: number): AudioChunk {
    const channels: Float32Array[] = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }
    
    return {
      id: `${trackId}-${chunkIndex}`,
      trackId,
      chunkIndex,
      sampleRate: audioBuffer.sampleRate,
      length: audioBuffer.length,
      channels
    };
  }
  
  // Load remaining chunks in background
  private async loadRemainingChunksInBackground(
    url: string,
    trackId: string,
    initialChunkSize: number,
    subsequentChunkSize: number,
    fileSize: number,
    progressCallback?: ProgressCallback
  ): Promise<void> {
    let currentOffset = initialChunkSize;
    let chunkIndex = 1;
    const totalChunks = Math.ceil(fileSize / subsequentChunkSize);
    
    try {
      while (currentOffset < fileSize) {
        const endOffset = Math.min(currentOffset + subsequentChunkSize - 1, fileSize - 1);
        
        console.log(`[AudioChunkStore] Loading background chunk ${chunkIndex} (${(currentOffset / 1024).toFixed(1)}KB - ${(endOffset / 1024).toFixed(1)}KB)`);
        
        const response = await fetch(url, {
          headers: {
            'Range': `bytes=${currentOffset}-${endOffset}`
          }
        });
        
        if (!response.ok && response.status !== 206) {
          console.warn(`[AudioChunkStore] Failed to fetch background chunk ${chunkIndex}: ${response.status}`);
          break;
        }
        
        const chunkBuffer = await response.arrayBuffer();
        
        // For background chunks, we might store them as raw data for later processing
        // This is a simplified approach - in production, you might want to decode incrementally
        
        progressCallback?.(chunkIndex + 1, totalChunks, true);
        
        currentOffset = endOffset + 1;
        chunkIndex++;
        
        // Add small delay to prevent overwhelming the browser
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      console.log(`[AudioChunkStore] Completed background loading for ${trackId}`);
      
    } catch (error) {
      console.warn(`[AudioChunkStore] Background loading failed: ${error}`);
    }
  }

  /**
   * Store assembly chunks from streaming assembler
   */
  async storeAssemblyChunks(
    trackId: string,
    name: string,
    assemblyChunks: import('./StreamingAssembler.js').AssemblyChunk[],
    progressCallback?: ProgressCallback
  ): Promise<AudioMetadata> {
    if (!this.initialized) await this.initialize();
    
    console.log(`[AudioChunkStore] Storing ${assemblyChunks.length} assembly chunks for: ${name} (${trackId})`);
    
    // Calculate total metadata from assembly chunks
    const totalSize = assemblyChunks.reduce((sum, chunk) => sum + chunk.totalSize, 0);
    
    // Use first chunk to get audio metadata (decode small portion for properties)
    const firstChunk = assemblyChunks[0];
    if (!firstChunk) {
      throw new Error('No assembly chunks provided');
    }
    
    // Decode first chunk to get audio properties
    const firstBuffer = await this.audioContext.decodeAudioData(firstChunk.data.slice(0));
    
    const metadata: AudioMetadata = {
      trackId,
      name,
      duration: 0, // Will be calculated from all chunks
      sampleRate: firstBuffer.sampleRate,
      numberOfChannels: firstBuffer.numberOfChannels,
      totalChunks: assemblyChunks.length,
      lastAccessed: Date.now(),
      fileSize: totalSize,
      url: `assembly://${trackId}` // Special URL to indicate assembly origin
    };
    
    // Store metadata first
    await this.saveMetadata(metadata);
    
    // Convert assembly chunks to storage chunks
    let totalDuration = 0;
    for (let i = 0; i < assemblyChunks.length; i++) {
      const assemblyChunk = assemblyChunks[i];
      
      // Decode the chunk to get proper audio data
      const audioBuffer = await this.audioContext.decodeAudioData(assemblyChunk.data.slice(0));
      totalDuration += audioBuffer.duration;
      
      // Convert to storage chunk format
      const storageChunk = this.audioBufferToStorageChunk(audioBuffer, trackId, i);
      await this.saveChunk(storageChunk);
      
      // Report progress
      if (progressCallback) {
        const canStartPlayback = i === 0; // First chunk enables playback
        progressCallback(i + 1, assemblyChunks.length, canStartPlayback);
      }
    }
    
    // Update metadata with correct duration
    metadata.duration = totalDuration;
    await this.saveMetadata(metadata);
    
    console.log(`[AudioChunkStore] Stored ${assemblyChunks.length} assembly chunks for ${name} (total duration: ${totalDuration.toFixed(2)}s)`);
    return metadata;
  }

  /**
   * Convert an AudioBuffer to a storage chunk
   */
  private audioBufferToStorageChunk(audioBuffer: AudioBuffer, trackId: string, chunkIndex: number): AudioChunk {
    const channels: Float32Array[] = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }
    
    return {
      id: `${trackId}-${chunkIndex}`,
      trackId,
      chunkIndex,
      sampleRate: audioBuffer.sampleRate,
      length: audioBuffer.length,
      channels
    };
  }

  /**
   * Get first chunk for instant playback (optimized for assembly chunks)
   */
  async getFirstChunkBuffer(trackId: string): Promise<AudioBuffer | null> {
    if (!this.initialized) await this.initialize();
    
    const firstChunk = await this.getChunk(trackId, 0);
    if (!firstChunk) return null;
    
    // Create AudioBuffer from first chunk
    const audioBuffer = this.audioContext.createBuffer(
      firstChunk.channels.length,
      firstChunk.length,
      firstChunk.sampleRate
    );
    
    for (let c = 0; c < firstChunk.channels.length; c++) {
      const channelData = audioBuffer.getChannelData(c);
      channelData.set(firstChunk.channels[c]);
    }
    
    return audioBuffer;
  }

  // Get storage statistics
  async getStorageInfo(): Promise<{
    totalTracks: number;
    totalSize: number;
    oldestTrack: number;
    newestTrack: number;
    instantModeEnabled: boolean;
    chunkSizeConfig: {
      initialChunkSize: number;
      subsequentChunkSize: number;
    };
  }> {
    const allMetadata = await this.getAllMetadata();
    
    return {
      totalTracks: allMetadata.length,
      totalSize: allMetadata.reduce((sum, m) => sum + m.fileSize, 0),
      oldestTrack: allMetadata.length > 0 ? Math.min(...allMetadata.map(m => m.lastAccessed)) : 0,
      newestTrack: allMetadata.length > 0 ? Math.max(...allMetadata.map(m => m.lastAccessed)) : 0,
      instantModeEnabled: this.instantChunkConfig.enableInstantMode,
      chunkSizeConfig: {
        initialChunkSize: this.instantChunkConfig.initialChunkSize,
        subsequentChunkSize: this.instantChunkConfig.subsequentChunkSize
      }
    };
  }
  
  // Get performance metrics for instant playback
  getInstantPlaybackMetrics(): {
    initialChunkSize: number;
    subsequentChunkSize: number;
    estimatedInitialLoadTime: number;
    optimalForInstantPlayback: boolean;
  } {
    const initialSizeKB = this.instantChunkConfig.initialChunkSize / 1024;
    const subsequentSizeKB = this.instantChunkConfig.subsequentChunkSize / 1024;
    
    // Estimate load time based on typical connection speeds
    // Using conservative 3G speeds as baseline (1.5 Mbps = ~200 KB/s)
    const estimatedInitialLoadTime = (initialSizeKB / 200) * 1000; // ms
    const optimalForInstantPlayback = estimatedInitialLoadTime <= 500; // Under 500ms
    
    return {
      initialChunkSize: this.instantChunkConfig.initialChunkSize,
      subsequentChunkSize: this.instantChunkConfig.subsequentChunkSize,
      estimatedInitialLoadTime,
      optimalForInstantPlayback
    };
  }
}