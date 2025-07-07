// StreamingAssembler.ts
// Assembles download chunks into storage chunks and playback buffers
// Bridges the gap between network-optimized downloads and storage-optimized chunks

import { DownloadChunk } from './DownloadManager.js';

export interface AssemblyChunk {
  id: string;
  storageIndex: number;
  downloadChunks: DownloadChunk[];
  totalSize: number;
  data: ArrayBuffer;
  assemblyTime: number;
  canStartPlayback: boolean; // True if this chunk can start audio playback
}

export interface StreamingAssemblerOptions {
  storageChunkSize: number;        // Target size for storage chunks (1-3MB)
  playbackChunkSize: number;       // Size for initial playback chunk (256-384KB)
  onChunkAssembled?: (chunk: AssemblyChunk) => void;
  onPlaybackReady?: (firstChunk: AssemblyChunk) => void;
  onProgress?: (assembled: number, total: number) => void;
}

/**
 * Streaming assembler that converts network-optimized download chunks
 * into storage-optimized chunks and playback-ready buffers
 * 
 * Key features:
 * - Assembles small download chunks (64KB-512KB) into larger storage chunks (1-3MB)
 * - Creates optimal first chunk for instant playback (256-384KB)
 * - Streams assembly - doesn't wait for all downloads to complete
 * - Memory efficient - releases download chunks after assembly
 * - iOS Safari optimized chunk sizes
 */
export class StreamingAssembler {
  private options: StreamingAssemblerOptions;
  private downloadChunks: Map<number, DownloadChunk> = new Map();
  private assembledChunks: Map<number, AssemblyChunk> = new Map();
  private totalExpectedSize: number = 0;
  private isPlaybackReady: boolean = false;
  
  // Assembly state tracking
  private nextStorageIndex: number = 0;
  private currentAssemblyBuffer: ArrayBuffer | null = null;
  private currentAssemblySize: number = 0;
  private currentDownloadChunks: DownloadChunk[] = [];

  constructor(options: StreamingAssemblerOptions) {
    this.options = options;
    
    console.log(`[StreamingAssembler] Initialized with storage chunk size: ${(options.storageChunkSize / 1024 / 1024).toFixed(1)}MB, playback chunk size: ${(options.playbackChunkSize / 1024).toFixed(0)}KB`);
  }

  /**
   * Initialize assembly for a specific total file size
   */
  initialize(totalSize: number): void {
    this.totalExpectedSize = totalSize;
    this.downloadChunks.clear();
    this.assembledChunks.clear();
    this.nextStorageIndex = 0;
    this.currentAssemblyBuffer = null;
    this.currentAssemblySize = 0;
    this.currentDownloadChunks = [];
    this.isPlaybackReady = false;
    
    console.log(`[StreamingAssembler] Initialized for ${(totalSize / 1024 / 1024).toFixed(2)}MB file`);
  }

  /**
   * Add a downloaded chunk for assembly
   */
  addDownloadChunk(chunk: DownloadChunk): void {
    this.downloadChunks.set(chunk.index, chunk);
    
    // Process chunks in order as they become available
    this.processAvailableChunks();
  }

  /**
   * Process all available sequential chunks
   */
  private processAvailableChunks(): void {
    // Find the next sequential chunk we can process
    let nextIndex = this.getNextSequentialIndex();
    
    while (this.downloadChunks.has(nextIndex)) {
      const chunk = this.downloadChunks.get(nextIndex)!;
      this.processDownloadChunk(chunk);
      this.downloadChunks.delete(nextIndex); // Free memory
      nextIndex++;
    }
  }

  /**
   * Get the next sequential download chunk index we're waiting for
   */
  private getNextSequentialIndex(): number {
    // Count total chunks processed so far
    let processedChunks = 0;
    for (const assembledChunk of this.assembledChunks.values()) {
      processedChunks += assembledChunk.downloadChunks.length;
    }
    // Add current assembly buffer chunks
    processedChunks += this.currentDownloadChunks.length;
    
    return processedChunks;
  }

  /**
   * Process a single download chunk into the assembly buffer
   */
  private processDownloadChunk(chunk: DownloadChunk): void {
    // Add chunk to current assembly
    this.currentDownloadChunks.push(chunk);
    
    // Combine with existing assembly buffer
    const newTotalSize = this.currentAssemblySize + chunk.data.byteLength;
    const combined = new ArrayBuffer(newTotalSize);
    const combinedView = new Uint8Array(combined);
    
    // Copy existing data
    if (this.currentAssemblyBuffer) {
      const existingView = new Uint8Array(this.currentAssemblyBuffer);
      combinedView.set(existingView, 0);
    }
    
    // Append new chunk
    const chunkView = new Uint8Array(chunk.data);
    combinedView.set(chunkView, this.currentAssemblySize);
    
    this.currentAssemblyBuffer = combined;
    this.currentAssemblySize = newTotalSize;
    
    // Check if we should create an assembly chunk
    this.checkForAssemblyCompletion();
  }

  /**
   * Check if current assembly should be completed
   */
  private checkForAssemblyCompletion(): void {
    if (!this.currentAssemblyBuffer) return;
    
    const shouldComplete = this.shouldCompleteCurrentAssembly();
    
    if (shouldComplete) {
      this.completeCurrentAssembly();
    }
  }

  /**
   * Determine if current assembly should be completed
   */
  private shouldCompleteCurrentAssembly(): boolean {
    // First chunk - optimize for playback start
    if (this.nextStorageIndex === 0) {
      // Complete when we reach playback chunk size for instant start
      return this.currentAssemblySize >= this.options.playbackChunkSize;
    }
    
    // Subsequent chunks - optimize for storage efficiency
    const reachedStorageSize = this.currentAssemblySize >= this.options.storageChunkSize;
    const isLastChunk = this.isLastAssemblyChunk();
    
    return reachedStorageSize || isLastChunk;
  }

  /**
   * Check if this is the last assembly chunk
   */
  private isLastAssemblyChunk(): boolean {
    // Calculate how much data we've processed
    let processedBytes = 0;
    for (const assembledChunk of this.assembledChunks.values()) {
      processedBytes += assembledChunk.totalSize;
    }
    processedBytes += this.currentAssemblySize;
    
    return processedBytes >= this.totalExpectedSize;
  }

  /**
   * Complete the current assembly and create an AssemblyChunk
   */
  private completeCurrentAssembly(): void {
    if (!this.currentAssemblyBuffer || this.currentDownloadChunks.length === 0) {
      return;
    }
    
    const assemblyStartTime = performance.now();
    
    const assemblyChunk: AssemblyChunk = {
      id: `assembly-${this.nextStorageIndex}`,
      storageIndex: this.nextStorageIndex,
      downloadChunks: [...this.currentDownloadChunks], // Copy array
      totalSize: this.currentAssemblySize,
      data: this.currentAssemblyBuffer,
      assemblyTime: performance.now() - assemblyStartTime,
      canStartPlayback: this.nextStorageIndex === 0 && !this.isPlaybackReady
    };
    
    this.assembledChunks.set(this.nextStorageIndex, assemblyChunk);
    
    console.log(`[StreamingAssembler] Assembled chunk ${this.nextStorageIndex}: ${(assemblyChunk.totalSize / 1024).toFixed(0)}KB from ${assemblyChunk.downloadChunks.length} download chunks`);
    
    // Check if this is the first playback-ready chunk
    if (assemblyChunk.canStartPlayback) {
      this.isPlaybackReady = true;
      console.log(`[StreamingAssembler] 🎵 First chunk ready for playback: ${(assemblyChunk.totalSize / 1024).toFixed(0)}KB`);
      this.options.onPlaybackReady?.(assemblyChunk);
    }
    
    // Notify listeners
    this.options.onChunkAssembled?.(assemblyChunk);
    this.reportProgress();
    
    // Reset assembly state for next chunk
    this.nextStorageIndex++;
    this.currentAssemblyBuffer = null;
    this.currentAssemblySize = 0;
    this.currentDownloadChunks = [];
  }

  /**
   * Report assembly progress
   */
  private reportProgress(): void {
    const assembledChunks = this.assembledChunks.size;
    
    // Estimate total chunks based on file size and chunk sizes
    let estimatedTotalChunks = 1; // At least one chunk
    if (this.totalExpectedSize > 0) {
      const firstChunkSize = this.options.playbackChunkSize;
      const remainingSize = Math.max(0, this.totalExpectedSize - firstChunkSize);
      const remainingChunks = Math.ceil(remainingSize / this.options.storageChunkSize);
      estimatedTotalChunks = 1 + remainingChunks;
    }
    
    this.options.onProgress?.(assembledChunks, estimatedTotalChunks);
  }

  /**
   * Force completion of any pending assembly
   */
  finalize(): void {
    if (this.currentAssemblyBuffer && this.currentDownloadChunks.length > 0) {
      this.completeCurrentAssembly();
    }
    
    console.log(`[StreamingAssembler] Finalized: ${this.assembledChunks.size} total chunks assembled`);
  }

  /**
   * Get all assembled chunks in order
   */
  getAssembledChunks(): AssemblyChunk[] {
    const chunks: AssemblyChunk[] = [];
    for (let i = 0; i < this.nextStorageIndex; i++) {
      const chunk = this.assembledChunks.get(i);
      if (chunk) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  /**
   * Get first chunk for immediate playback
   */
  getFirstChunk(): AssemblyChunk | null {
    return this.assembledChunks.get(0) || null;
  }

  /**
   * Get assembly statistics
   */
  getStats(): {
    assembledChunks: number;
    totalAssembledSize: number;
    pendingDownloadChunks: number;
    isPlaybackReady: boolean;
    assemblyProgress: number; // 0-1
  } {
    const totalAssembledSize = Array.from(this.assembledChunks.values())
      .reduce((sum, chunk) => sum + chunk.totalSize, 0);
    
    const assemblyProgress = this.totalExpectedSize > 0 ? 
      (totalAssembledSize + this.currentAssemblySize) / this.totalExpectedSize : 0;
    
    return {
      assembledChunks: this.assembledChunks.size,
      totalAssembledSize,
      pendingDownloadChunks: this.downloadChunks.size,
      isPlaybackReady: this.isPlaybackReady,
      assemblyProgress: Math.min(assemblyProgress, 1)
    };
  }

  /**
   * Clear all data to free memory
   */
  cleanup(): void {
    this.downloadChunks.clear();
    this.assembledChunks.clear();
    this.currentAssemblyBuffer = null;
    this.currentDownloadChunks = [];
    this.currentAssemblySize = 0;
    
    console.log(`[StreamingAssembler] Cleanup completed`);
  }
}