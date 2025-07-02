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
  private chunkSizeBytes: number = 3 * 1024 * 1024; // 3MB per chunk
  private initialized = false;
  private readonly dbName = 'WAS_MediaCache_v1';
  private readonly dbVersion = 2;
  
  // Simple obfuscation key (not for real security, just to deter casual inspection)
  private readonly obfuscationKey = 'WebAudioStream2024';
  
  // Storage limits
  private readonly maxStorageSize = 1024 * 1024 * 1024; // 1GB
  private readonly maxAge = 10 * 24 * 60 * 60 * 1000; // 10 days
  private readonly minChunksForPlayback = 1; // Start playback after 1 chunk (3MB loads quickly)

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
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

  // Get storage statistics
  async getStorageInfo(): Promise<{
    totalTracks: number;
    totalSize: number;
    oldestTrack: number;
    newestTrack: number;
  }> {
    const allMetadata = await this.getAllMetadata();
    
    return {
      totalTracks: allMetadata.length,
      totalSize: allMetadata.reduce((sum, m) => sum + m.fileSize, 0),
      oldestTrack: Math.min(...allMetadata.map(m => m.lastAccessed)),
      newestTrack: Math.max(...allMetadata.map(m => m.lastAccessed))
    };
  }
}