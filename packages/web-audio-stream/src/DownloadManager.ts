// DownloadManager.ts
// Independent network download manager for optimal audio streaming
// Separates download strategy from storage chunking for maximum performance

export interface DownloadChunk {
  index: number;
  start: number;
  end: number;
  data: ArrayBuffer;
  downloadTime: number;
}

export interface DownloadProgress {
  bytesLoaded: number;
  bytesTotal: number;
  chunksCompleted: number;
  chunksTotal: number;
  downloadSpeed: number; // bytes per second
  estimatedTimeRemaining: number; // milliseconds
}

export interface DownloadStrategy {
  initialChunkSize: number;    // Size for first chunk (optimized for speed)
  standardChunkSize: number;   // Size for subsequent chunks
  maxConcurrentDownloads: number; // Parallel download limit
  priorityFirstChunk: boolean; // Download first chunk at max priority
  adaptiveChunkSizing: boolean; // Adjust size based on connection speed
}

export interface DownloadManagerOptions {
  strategy?: Partial<DownloadStrategy>;
  onProgress?: (progress: DownloadProgress) => void;
  onChunkComplete?: (chunk: DownloadChunk) => void;
  onComplete?: (totalTime: number, avgSpeed: number) => void;
  onError?: (error: Error) => void;
}

/**
 * Advanced download manager that optimizes network transfers independently from storage
 * 
 * Key features:
 * - Network-optimized chunk sizes (64KB-512KB) separate from storage chunks
 * - Parallel downloads with configurable concurrency
 * - Adaptive chunk sizing based on connection speed
 * - Priority downloading for first chunk (instant playback)
 * - Range request optimization for HTTP/2 performance
 * - Connection speed detection and adaptation
 */
export class DownloadManager {
  private strategy: DownloadStrategy;
  private onProgress?: (progress: DownloadProgress) => void;
  private onChunkComplete?: (chunk: DownloadChunk) => void;
  private onComplete?: (totalTime: number, avgSpeed: number) => void;
  private onError?: (error: Error) => void;
  
  // Download state
  private activeDownloads = new Set<number>();
  private completedChunks = new Map<number, DownloadChunk>();
  private downloadStartTime: number = 0;
  private totalBytesDownloaded: number = 0;
  private connectionSpeed: number = 0; // bytes per second
  
  // Connection speed detection
  private speedSamples: number[] = [];
  private readonly MAX_SPEED_SAMPLES = 5;
  
  // iOS Safari optimizations
  private readonly isIOSSafari: boolean;

  constructor(options: DownloadManagerOptions = {}) {
    // Detect iOS Safari for optimizations
    this.isIOSSafari = this.detectIOSSafari();
    
    // Set default strategy with iOS optimizations
    this.strategy = {
      initialChunkSize: this.isIOSSafari ? 128 * 1024 : 256 * 1024, // 128KB iOS, 256KB others
      standardChunkSize: this.isIOSSafari ? 256 * 1024 : 512 * 1024, // 256KB iOS, 512KB others  
      maxConcurrentDownloads: this.isIOSSafari ? 2 : 4, // Limit concurrent on iOS
      priorityFirstChunk: true,
      adaptiveChunkSizing: true,
      ...options.strategy
    };
    
    this.onProgress = options.onProgress;
    this.onChunkComplete = options.onChunkComplete;
    this.onComplete = options.onComplete;
    this.onError = options.onError;
    
    console.log(`[DownloadManager] Initialized with strategy:`, {
      ...this.strategy,
      isIOSSafari: this.isIOSSafari
    });
  }

  private detectIOSSafari(): boolean {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(userAgent);
    const isSafari = /Safari/.test(userAgent) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(userAgent);
    return isIOS && isSafari;
  }

  /**
   * Check if server supports range requests
   */
  async checkRangeRequestSupport(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: {
          'Range': 'bytes=0-1'
        }
      });
      
      const acceptsRanges = response.headers.get('Accept-Ranges');
      const contentRange = response.headers.get('Content-Range');
      const status = response.status;
      
      // Server supports range requests if:
      // - Returns 206 Partial Content, or
      // - Returns Accept-Ranges: bytes header, or
      // - Returns Content-Range header
      const supportsRanges = status === 206 || 
                           acceptsRanges === 'bytes' || 
                           contentRange !== null;
      
      console.log(`[DownloadManager] Range request support for ${url}: ${supportsRanges}`);
      return supportsRanges;
      
    } catch (error) {
      console.warn(`[DownloadManager] Failed to check range support: ${error}`);
      return false;
    }
  }

  /**
   * Get optimal download strategy for a file
   */
  async getOptimalStrategy(url: string, estimatedFileSize?: number): Promise<DownloadStrategy> {
    const supportsRanges = await this.checkRangeRequestSupport(url);
    
    if (!supportsRanges) {
      // No range support - download entire file
      return {
        ...this.strategy,
        initialChunkSize: estimatedFileSize || 10 * 1024 * 1024, // Full file
        standardChunkSize: estimatedFileSize || 10 * 1024 * 1024,
        maxConcurrentDownloads: 1,
        priorityFirstChunk: false,
        adaptiveChunkSizing: false
      };
    }
    
    // Optimize strategy based on estimated file size
    if (estimatedFileSize) {
      if (estimatedFileSize < 1024 * 1024) {
        // Small file < 1MB - download in 2-3 chunks
        return {
          ...this.strategy,
          initialChunkSize: Math.min(this.strategy.initialChunkSize, Math.floor(estimatedFileSize / 3)),
          standardChunkSize: Math.min(this.strategy.standardChunkSize, Math.floor(estimatedFileSize / 2)),
          maxConcurrentDownloads: 2
        };
      } else if (estimatedFileSize > 10 * 1024 * 1024) {
        // Large file > 10MB - use larger chunks to reduce overhead
        return {
          ...this.strategy,
          standardChunkSize: this.isIOSSafari ? 512 * 1024 : 1024 * 1024, // 512KB iOS, 1MB others
          maxConcurrentDownloads: this.isIOSSafari ? 3 : 6
        };
      }
    }
    
    return this.strategy;
  }

  /**
   * Download audio file with optimized chunking strategy
   */
  async downloadAudio(url: string, options: {
    estimatedFileSize?: number;
    priorityFirstChunk?: boolean;
  } = {}): Promise<{
    chunks: DownloadChunk[];
    totalSize: number;
    downloadTime: number;
    averageSpeed: number;
  }> {
    console.log(`[DownloadManager] Starting optimized download: ${url}`);
    
    // Reset state
    this.activeDownloads.clear();
    this.completedChunks.clear();
    this.totalBytesDownloaded = 0;
    this.speedSamples = [];
    this.downloadStartTime = performance.now();
    
    // Get optimal strategy for this download
    const strategy = await this.getOptimalStrategy(url, options.estimatedFileSize);
    
    try {
      // First, get file size via HEAD request
      const headResponse = await fetch(url, { method: 'HEAD' });
      const contentLength = headResponse.headers.get('Content-Length');
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0;
      
      if (!totalSize) {
        throw new Error('Unable to determine file size');
      }
      
      console.log(`[DownloadManager] File size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
      
      // Calculate download chunks based on strategy
      const chunks = this.calculateDownloadChunks(totalSize, strategy);
      
      // Download with priority handling
      if (options.priorityFirstChunk && chunks.length > 0) {
        await this.downloadPriorityFirst(url, chunks, totalSize);
      } else {
        await this.downloadParallel(url, chunks, totalSize);
      }
      
      const totalTime = performance.now() - this.downloadStartTime;
      const averageSpeed = totalSize / (totalTime / 1000); // bytes per second
      
      console.log(`[DownloadManager] Download complete: ${totalTime.toFixed(2)}ms, ${(averageSpeed / 1024 / 1024).toFixed(2)}MB/s`);
      
      // Sort chunks by index for assembly
      const sortedChunks = Array.from(this.completedChunks.values()).sort((a, b) => a.index - b.index);
      
      this.onComplete?.(totalTime, averageSpeed);
      
      return {
        chunks: sortedChunks,
        totalSize,
        downloadTime: totalTime,
        averageSpeed
      };
      
    } catch (error) {
      const downloadError = error as Error;
      console.error(`[DownloadManager] Download failed: ${downloadError.message}`);
      this.onError?.(downloadError);
      throw downloadError;
    }
  }

  /**
   * Calculate optimal download chunks based on strategy
   */
  private calculateDownloadChunks(totalSize: number, strategy: DownloadStrategy): Array<{index: number, start: number, end: number}> {
    const chunks: Array<{index: number, start: number, end: number}> = [];
    let offset = 0;
    let chunkIndex = 0;
    
    // First chunk (priority chunk for instant playback)
    if (offset < totalSize) {
      const chunkSize = Math.min(strategy.initialChunkSize, totalSize - offset);
      chunks.push({
        index: chunkIndex++,
        start: offset,
        end: offset + chunkSize - 1
      });
      offset += chunkSize;
    }
    
    // Subsequent chunks
    while (offset < totalSize) {
      let chunkSize = strategy.standardChunkSize;
      
      // Adaptive chunk sizing based on connection speed
      if (strategy.adaptiveChunkSizing && this.connectionSpeed > 0) {
        // Increase chunk size for faster connections to reduce overhead
        if (this.connectionSpeed > 5 * 1024 * 1024) { // > 5MB/s
          chunkSize = Math.min(chunkSize * 2, this.isIOSSafari ? 512 * 1024 : 1024 * 1024);
        } else if (this.connectionSpeed < 1024 * 1024) { // < 1MB/s
          chunkSize = Math.max(chunkSize / 2, 64 * 1024); // Min 64KB
        }
      }
      
      chunkSize = Math.min(chunkSize, totalSize - offset);
      
      chunks.push({
        index: chunkIndex++,
        start: offset,
        end: offset + chunkSize - 1
      });
      
      offset += chunkSize;
    }
    
    console.log(`[DownloadManager] Calculated ${chunks.length} download chunks (${strategy.initialChunkSize / 1024}KB first, ${strategy.standardChunkSize / 1024}KB standard)`);
    return chunks;
  }

  /**
   * Download with priority first chunk for instant playback
   */
  private async downloadPriorityFirst(
    url: string, 
    chunks: Array<{index: number, start: number, end: number}>, 
    totalSize: number
  ): Promise<void> {
    if (chunks.length === 0) return;
    
    // Download first chunk immediately at high priority
    console.log(`[DownloadManager] Priority downloading first chunk (${((chunks[0].end - chunks[0].start + 1) / 1024).toFixed(0)}KB)`);
    await this.downloadChunk(url, chunks[0]);
    
    // Download remaining chunks in parallel
    if (chunks.length > 1) {
      const remainingChunks = chunks.slice(1);
      await this.downloadParallel(url, remainingChunks, totalSize);
    }
  }

  /**
   * Download chunks in parallel with concurrency control
   */
  private async downloadParallel(
    url: string, 
    chunks: Array<{index: number, start: number, end: number}>, 
    totalSize: number
  ): Promise<void> {
    const maxConcurrent = this.strategy.maxConcurrentDownloads;
    const promises: Promise<void>[] = [];
    
    // Process chunks in batches to control concurrency
    for (let i = 0; i < chunks.length; i += maxConcurrent) {
      const batch = chunks.slice(i, i + maxConcurrent);
      const batchPromises = batch.map(chunk => this.downloadChunk(url, chunk));
      
      // Wait for current batch to complete before starting next
      await Promise.all(batchPromises);
      
      // Update progress
      this.reportProgress(totalSize);
    }
  }

  /**
   * Download a single chunk with range request
   */
  private async downloadChunk(url: string, chunkInfo: {index: number, start: number, end: number}): Promise<void> {
    const { index, start, end } = chunkInfo;
    const chunkStartTime = performance.now();
    
    this.activeDownloads.add(index);
    
    try {
      const response = await fetch(url, {
        headers: {
          'Range': `bytes=${start}-${end}`
        }
      });
      
      if (!response.ok && response.status !== 206) {
        throw new Error(`Chunk download failed: ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const downloadTime = performance.now() - chunkStartTime;
      
      // Update connection speed estimation
      const chunkSize = arrayBuffer.byteLength;
      const chunkSpeed = chunkSize / (downloadTime / 1000); // bytes per second
      this.updateConnectionSpeed(chunkSpeed);
      
      const chunk: DownloadChunk = {
        index,
        start,
        end,
        data: arrayBuffer,
        downloadTime
      };
      
      this.completedChunks.set(index, chunk);
      this.totalBytesDownloaded += chunkSize;
      this.activeDownloads.delete(index);
      
      console.log(`[DownloadManager] Downloaded chunk ${index}: ${(chunkSize / 1024).toFixed(0)}KB in ${downloadTime.toFixed(2)}ms (${(chunkSpeed / 1024 / 1024).toFixed(2)}MB/s)`);
      
      this.onChunkComplete?.(chunk);
      
    } catch (error) {
      this.activeDownloads.delete(index);
      console.error(`[DownloadManager] Failed to download chunk ${index}:`, error);
      throw error;
    }
  }

  /**
   * Update connection speed estimation with smoothing
   */
  private updateConnectionSpeed(newSpeed: number): void {
    this.speedSamples.push(newSpeed);
    if (this.speedSamples.length > this.MAX_SPEED_SAMPLES) {
      this.speedSamples.shift();
    }
    
    // Calculate smoothed average speed
    this.connectionSpeed = this.speedSamples.reduce((sum, speed) => sum + speed, 0) / this.speedSamples.length;
  }

  /**
   * Report download progress
   */
  private reportProgress(totalSize: number): void {
    const chunksCompleted = this.completedChunks.size;
    const chunksTotal = this.activeDownloads.size + chunksCompleted;
    const elapsedTime = performance.now() - this.downloadStartTime;
    
    let estimatedTimeRemaining = 0;
    if (this.connectionSpeed > 0 && totalSize > this.totalBytesDownloaded) {
      const remainingBytes = totalSize - this.totalBytesDownloaded;
      estimatedTimeRemaining = (remainingBytes / this.connectionSpeed) * 1000; // milliseconds
    }
    
    const progress: DownloadProgress = {
      bytesLoaded: this.totalBytesDownloaded,
      bytesTotal: totalSize,
      chunksCompleted,
      chunksTotal,
      downloadSpeed: this.connectionSpeed,
      estimatedTimeRemaining
    };
    
    this.onProgress?.(progress);
  }

  /**
   * Assemble downloaded chunks into a complete ArrayBuffer
   */
  static assembleChunks(chunks: DownloadChunk[]): ArrayBuffer {
    // Sort chunks by index to ensure correct order
    const sortedChunks = chunks.sort((a, b) => a.index - b.index);
    
    // Calculate total size
    const totalSize = sortedChunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
    
    // Create combined buffer
    const combined = new ArrayBuffer(totalSize);
    const combinedView = new Uint8Array(combined);
    
    let offset = 0;
    for (const chunk of sortedChunks) {
      const chunkView = new Uint8Array(chunk.data);
      combinedView.set(chunkView, offset);
      offset += chunk.data.byteLength;
    }
    
    return combined;
  }

  /**
   * Get current download statistics
   */
  getDownloadStats(): {
    activeDownloads: number;
    completedChunks: number;
    connectionSpeed: number;
    totalBytesDownloaded: number;
  } {
    return {
      activeDownloads: this.activeDownloads.size,
      completedChunks: this.completedChunks.size,
      connectionSpeed: this.connectionSpeed,
      totalBytesDownloaded: this.totalBytesDownloaded
    };
  }
}