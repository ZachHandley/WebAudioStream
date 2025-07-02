// audio-worklet-processor.js
// AudioWorklet processor for iOS Safari-safe audio playback with progressive streaming
// Fixes pitch/speed issues and prevents page reloads on iOS Safari

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    this.isPlaying = false;
    this.volume = 1.0;
    this.currentTime = 0;
    this.duration = 0;
    this.audioBuffer = null;
    this.bufferSourcePosition = 0;
    
    // Progressive buffer switching support
    this.scheduledBuffers = []; // Array of {trackId, channelData, sampleRate, numberOfChannels, totalSamples, duration, switchTime}
    this.currentBufferIndex = 0;
    this.nextSwitchTime = null;
    this.currentBufferEarlyStopTime = null; // Early stop time for current buffer
    this.currentTrackId = null; // Track ID for automatic song change detection
    
    // Chunked buffer assembly support
    this.pendingChunkedBuffers = new Map(); // Map<trackId, {metadata, chunks, receivedChunks, channelData, startTime}>
    this.maxChunkAssemblyTime = 30000; // 30 seconds in milliseconds
    
    // Logging throttle to prevent spam
    this.hasLoggedEarlyStopContinue = false; // Flag to prevent repetitive early-stop logging
    
    // iOS Safari specific properties
    this.isIOSSafari = false;
    this.iosSampleRate = null;
    this.iosMaxChunkSize = null;
    
    // Handle messages from main thread
    this.port.onmessage = (event) => {
      const { type, data } = event.data;
      
      switch (type) {
        case 'SET_BUFFER':
          // Receive raw audio data instead of AudioBuffer
          const newTrackId = data.trackId;
          
          // Detect song change and auto-reset progressive buffers
          if (this.currentTrackId && this.currentTrackId !== newTrackId) {
            console.log(`[AudioWorklet] Song change detected: ${this.currentTrackId} -> ${newTrackId}, clearing progressive buffers`);
            this.autoResetForNewSong(newTrackId);
          } else if (!this.currentTrackId) {
            console.log(`[AudioWorklet] First song set: ${newTrackId}`);
            this.currentTrackId = newTrackId;
          }
          
          this.audioChannelData = data.channelData;
          this.sampleRate = this.isIOSSafari && this.iosSampleRate ? this.iosSampleRate : data.sampleRate;
          this.numberOfChannels = data.numberOfChannels;
          this.totalSamples = data.totalSamples;
          this.duration = this.totalSamples / this.sampleRate;
          this.currentBufferEarlyStopTime = Math.max(0, this.duration - 0.75); // Set early stop time
          // Always reset to beginning when setting new buffer
          this.bufferSourcePosition = 0;
          this.currentTime = 0;
          // Don't automatically set playing - let main thread control this
          break;
          
        case 'PLAY':
          this.isPlaying = true;
          
          if (!this.audioChannelData) {
            console.error(`[AudioWorklet] ❌ PLAY command received but no audio data available!`);
          }
          break;
          
        case 'PAUSE':
          this.isPlaying = false;
          break;
          
        case 'SEEK':
          if (this.audioChannelData && this.sampleRate) {
            this.bufferSourcePosition = Math.floor(data.time * this.sampleRate);
            this.currentTime = data.time;
          } else {
            console.error(`[AudioWorklet] ❌ SEEK failed - no audio data or sample rate`);
          }
          break;
          
        case 'REPLACE_BUFFER':
          // Seamlessly replace buffer during playback
          console.log(`[AudioWorklet] Replacing buffer seamlessly - maintaining position`);
          
          const replaceTrackId = data.trackId;
          
          // Validate trackId for buffer replacement
          if (this.currentTrackId && replaceTrackId !== this.currentTrackId) {
            console.log(`[AudioWorklet] Rejecting buffer replacement from wrong song: ${replaceTrackId} (current: ${this.currentTrackId})`);
            break;
          }
          
          // Store current playback state
          const wasPlaying = this.isPlaying;
          const currentSamplePosition = this.bufferSourcePosition;
          const currentTimeBeforeReplace = this.currentTime;
          const previousDuration = this.duration;
          
          // Update buffer data atomically
          this.audioChannelData = data.channelData;
          this.sampleRate = this.isIOSSafari && this.iosSampleRate ? this.iosSampleRate : data.sampleRate;
          this.numberOfChannels = data.numberOfChannels;
          this.totalSamples = data.totalSamples;
          this.duration = this.totalSamples / this.sampleRate;
          this.currentBufferEarlyStopTime = Math.max(0, this.duration - 0.75); // Update early stop time
          
          // Use precise position calculation - maintain exact sample position
          if (data.currentPosition !== undefined) {
            // Use the position from main thread, but ensure it's sample-accurate
            const requestedSamplePosition = Math.floor(data.currentPosition * this.sampleRate);
            this.bufferSourcePosition = Math.min(requestedSamplePosition, this.totalSamples - 1);
            this.currentTime = this.bufferSourcePosition / this.sampleRate;
          } else {
            // Maintain current sample position exactly
            this.bufferSourcePosition = Math.min(currentSamplePosition, this.totalSamples - 1);
            this.currentTime = this.bufferSourcePosition / this.sampleRate;
          }
          
          // Ensure we don't lose playing state
          this.isPlaying = wasPlaying;
          
          // Calculate buffer replacement time using start time from main thread
          const bufferReplacementTime = data.startTime ? Date.now() - data.startTime : 0;
          console.log(`[AudioWorklet] ✅ Buffer replaced seamlessly in ${bufferReplacementTime.toFixed(2)}ms - Duration: ${previousDuration}s -> ${this.duration}s, Position: ${this.currentTime}s`);
          break;
          
        case 'SET_VOLUME':
          this.volume = Math.max(0, Math.min(1, data.volume));
          break;
          
        case 'GET_POSITION':
          // Send current position back to main thread
          this.port.postMessage({
            type: 'POSITION_RESPONSE',
            currentTime: this.currentTime,
            duration: this.duration
          });
          break;
          
        case 'GET_CURRENT_POSITION':
          // Immediate position request for real-time buffer replacement
          this.port.postMessage({
            type: 'CURRENT_POSITION_RESPONSE',
            currentTime: this.currentTime,
            samplePosition: this.bufferSourcePosition,
            duration: this.duration,
            requestId: data.requestId // Echo back request ID for matching
          });
          break;
          
        case 'SCHEDULE_BUFFER_SWITCH':
          // Schedule a progressive buffer for future switching
          const bufferTrackId = data.trackId;
          
          // Validate trackId - only accept buffers for current song
          if (this.currentTrackId && bufferTrackId !== this.currentTrackId) {
            console.log(`[AudioWorklet] Rejecting buffer from wrong song: ${bufferTrackId} (current: ${this.currentTrackId})`);
            break;
          }
          
          const bufferData = {
            trackId: bufferTrackId,
            channelData: data.channelData,
            sampleRate: data.sampleRate,
            numberOfChannels: data.numberOfChannels,
            totalSamples: data.totalSamples,
            duration: data.totalSamples / data.sampleRate,
            switchTime: data.switchTime || null,
            earlyStopTime: data.earlyStopTime || null
          };
          
          this.scheduledBuffers.push(bufferData);
          
          // Update next switch time if this is the next buffer to switch to
          if (this.scheduledBuffers.length === this.currentBufferIndex + 1) {
            this.nextSwitchTime = bufferData.switchTime;
            // If switchTime is 0, this buffer is immediately active
            if (bufferData.switchTime === 0) {
              console.log(`[AudioWorklet] Buffer 0 is immediately active, setting as current buffer`);
              this.currentBufferIndex = 0;
              this.nextSwitchTime = null; // Will be set when next buffer is scheduled
            }
          }
          
          console.log(`[AudioWorklet] Scheduled buffer switch at ${bufferData.switchTime}s for buffer ${this.scheduledBuffers.length - 1} (trackId: ${bufferTrackId}, duration: ${bufferData.duration}s, early-stop: ${bufferData.earlyStopTime}s)`);
          console.log(`[AudioWorklet] Progressive buffer status: ${this.scheduledBuffers.length} buffers for trackId ${this.currentTrackId}, current index: ${this.currentBufferIndex}, next switch: ${this.nextSwitchTime}`);
          break;
          
        case 'GET_SWITCH_STATUS':
          // Return current buffer switching status
          this.port.postMessage({
            type: 'SWITCH_STATUS_RESPONSE',
            currentBufferIndex: this.currentBufferIndex,
            totalScheduledBuffers: this.scheduledBuffers.length,
            nextSwitchTime: this.nextSwitchTime,
            currentTime: this.currentTime
          });
          break;
          
        case 'START_CHUNKED_BUFFER':
          // Initialize chunked buffer assembly
          this.handleStartChunkedBuffer(data);
          break;
          
        case 'BUFFER_CHUNK':
          // Receive and assemble buffer chunk
          this.handleBufferChunk(data);
          break;
          
        case 'IOS_CONFIG':
          // iOS Safari configuration
          this.isIOSSafari = data.isIOSSafari;
          this.iosSampleRate = data.sampleRate;
          this.iosMaxChunkSize = data.maxChunkSize;
          console.log(`[AudioWorklet] iOS Safari config applied: ${this.iosSampleRate}Hz, max chunk: ${(this.iosMaxChunkSize / 1024 / 1024).toFixed(1)}MB`);
          break;
          
        case 'SAMPLE_RATE_UPDATE':
          // iOS sample rate change notification
          if (this.isIOSSafari) {
            const oldSampleRate = this.iosSampleRate || this.sampleRate;
            this.iosSampleRate = data.sampleRate;
            console.log(`[AudioWorklet] iOS sample rate updated: ${oldSampleRate}Hz → ${this.iosSampleRate}Hz`);
            
            // Recalculate timing if currently playing
            if (this.isPlaying && this.audioChannelData) {
              this.adjustTimingForSampleRateChange(oldSampleRate, this.iosSampleRate);
            }
          }
          break;
          
        default:
          break;
      }
    };
  }
  
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    
    if (!output || !this.audioChannelData || !this.isPlaying) {
      // DON'T send time updates when no audio data or not playing
      // This was causing the "0 duration: 0" spam
      return true;
    }
    
    const bufferLength = output[0].length;
    
    // Check for early-stop timing or progressive buffer switching before processing audio
    if (this.currentBufferEarlyStopTime !== null && this.currentTime >= this.currentBufferEarlyStopTime) {
      // Current buffer reached early-stop time, try to switch to next scheduled buffer
      if (this.scheduledBuffers.length > this.currentBufferIndex + 1) {
        console.log(`[AudioWorklet] Early-stop reached at ${this.currentTime.toFixed(3)}s (threshold: ${this.currentBufferEarlyStopTime.toFixed(3)}s), switching to buffer ${this.currentBufferIndex + 1}`);
        this.hasLoggedEarlyStopContinue = false; // Reset flag since we're switching
        this.performBufferSwitch();
      } else {
        // Only log once to prevent spam (this runs ~60 times per second)
        if (!this.hasLoggedEarlyStopContinue) {
          console.log(`[AudioWorklet] Early-stop reached at ${this.currentTime.toFixed(3)}s but no next buffer available (${this.scheduledBuffers.length} total buffers), continuing current buffer`);
          this.hasLoggedEarlyStopContinue = true;
        }
      }
    } else if (this.nextSwitchTime !== null && this.currentTime >= this.nextSwitchTime) {
      // Scheduled switch time reached
      console.log(`[AudioWorklet] Scheduled switch time ${this.nextSwitchTime.toFixed(3)}s reached at ${this.currentTime.toFixed(3)}s`);
      this.performBufferSwitch();
    }
    
    let audioEnded = false;
    
    // Process each channel
    for (let channel = 0; channel < output.length; channel++) {
      const outputChannel = output[channel];
      const channelIndex = Math.min(channel, this.numberOfChannels - 1);
      const inputChannel = this.audioChannelData[channelIndex];
      
      for (let i = 0; i < bufferLength; i++) {
        if (this.bufferSourcePosition < inputChannel.length) {
          outputChannel[i] = inputChannel[this.bufferSourcePosition] * this.volume;
        } else {
          outputChannel[i] = 0;
          // Mark that we've reached the end
          if (!audioEnded) {
            audioEnded = true;
          }
        }
        
        if (channel === 0) {
          this.bufferSourcePosition++;
        }
      }
    }
    
    // Send ENDED message only once when audio actually ends
    if (audioEnded && this.isPlaying) {
      this.isPlaying = false;
      this.port.postMessage({
        type: 'ENDED'
      });
      console.log('[AudioWorklet] Audio ended, sent ENDED message');
    }
    
    // Update current time
    this.currentTime = this.bufferSourcePosition / this.sampleRate;
    
    // Send time update to main thread periodically (every ~100ms)
    if (Math.floor(this.currentTime * 10) !== Math.floor((this.currentTime - bufferLength / this.sampleRate) * 10)) {
      this.port.postMessage({
        type: 'TIME_UPDATE',
        currentTime: this.currentTime,
        duration: this.duration
      });
    }
    
    return true;
  }
  
  // Perform seamless buffer switch to progressive buffer
  performBufferSwitch() {
    if (this.currentBufferIndex + 1 >= this.scheduledBuffers.length) {
      // No more buffers to switch to
      this.nextSwitchTime = null;
      return;
    }
    
    const nextBuffer = this.scheduledBuffers[this.currentBufferIndex + 1];
    
    // Validate trackId before switching
    if (this.currentTrackId && nextBuffer.trackId !== this.currentTrackId) {
      console.log(`[AudioWorklet] Skipping buffer switch - wrong trackId: ${nextBuffer.trackId} (current: ${this.currentTrackId})`);
      this.nextSwitchTime = null;
      return;
    }
    
    console.log(`[AudioWorklet] Switching to progressive buffer ${this.currentBufferIndex + 1} (${nextBuffer.trackId}) at ${this.currentTime.toFixed(3)}s (scheduled: ${this.nextSwitchTime?.toFixed(3)}s)`);
    
    // Seamlessly switch to the next progressive buffer
    this.audioChannelData = nextBuffer.channelData;
    this.sampleRate = nextBuffer.sampleRate;
    this.numberOfChannels = nextBuffer.numberOfChannels;
    this.totalSamples = nextBuffer.totalSamples;
    this.duration = nextBuffer.duration;
    this.currentBufferEarlyStopTime = Math.max(0, this.duration - 0.75); // Set new early stop time
    
    // Maintain current playback position exactly - the progressive buffer contains all previous audio
    // So the current position should work seamlessly in the new, longer buffer
    const currentSamplePosition = Math.floor(this.currentTime * this.sampleRate);
    this.bufferSourcePosition = Math.min(currentSamplePosition, this.totalSamples - 1);
    
    // Update buffer tracking
    this.currentBufferIndex++;
    
    // Schedule next switch if available
    if (this.currentBufferIndex + 1 < this.scheduledBuffers.length) {
      const nextBufferData = this.scheduledBuffers[this.currentBufferIndex + 1];
      this.nextSwitchTime = nextBufferData.switchTime;
      console.log(`[AudioWorklet] Next buffer switch scheduled for: ${this.nextSwitchTime?.toFixed(3)}s`);
    } else {
      this.nextSwitchTime = null;
    }
    
    // Notify main thread of successful switch
    this.port.postMessage({
      type: 'BUFFER_SWITCHED',
      newBufferIndex: this.currentBufferIndex,
      newDuration: this.duration,
      currentTime: this.currentTime
    });
  }
  
  // Automatic reset for new song
  autoResetForNewSong(newTrackId) {
    console.log(`[AudioWorklet] Auto-resetting progressive buffers for new song: ${newTrackId}`);
    
    // Clear all progressive buffer state
    this.scheduledBuffers = [];
    this.currentBufferIndex = 0;
    this.nextSwitchTime = null;
    this.currentBufferEarlyStopTime = null;
    
    // Reset logging flags
    this.hasLoggedEarlyStopContinue = false;
    
    // Clear chunked buffer state
    this.clearChunkedBuffersForTrack(this.currentTrackId);
    
    // Update current track ID
    this.currentTrackId = newTrackId;
    
    console.log(`[AudioWorklet] Progressive buffer state reset complete for ${newTrackId}`);
  }
  
  // Handle START_CHUNKED_BUFFER message
  handleStartChunkedBuffer(data) {
    const { trackId, sampleRate, numberOfChannels, totalSamples, totalChunks, switchTime, earlyStopTime } = data;
    
    // Validate trackId - only accept buffers for current song
    if (this.currentTrackId && trackId !== this.currentTrackId) {
      console.log(`[AudioWorklet] Rejecting chunked buffer from wrong song: ${trackId} (current: ${this.currentTrackId})`);
      return;
    }
    
    // Clear any existing chunked buffer for this track
    this.clearChunkedBuffersForTrack(trackId);
    
    // Initialize chunked buffer assembly state
    const chunkedBuffer = {
      metadata: {
        trackId,
        sampleRate,
        numberOfChannels,
        totalSamples,
        totalChunks,
        switchTime,
        earlyStopTime,
        duration: totalSamples / sampleRate
      },
      chunks: new Map(), // Map<chunkIndex, chunkData>
      receivedChunks: 0,
      channelData: null, // Will be assembled once all chunks are received
      startTime: Date.now() // Track when assembly started for timeout checking
    };
    
    // Initialize empty channel data arrays
    chunkedBuffer.channelData = [];
    for (let channel = 0; channel < numberOfChannels; channel++) {
      chunkedBuffer.channelData.push(new Float32Array(totalSamples));
    }
    
    this.pendingChunkedBuffers.set(trackId, chunkedBuffer);
    
    console.log(`[AudioWorklet] Started chunked buffer assembly for ${trackId} (${totalChunks} chunks, ${numberOfChannels} channels, ${totalSamples} samples)`);
  }
  
  // Handle BUFFER_CHUNK message
  handleBufferChunk(data) {
    const { trackId, chunkIndex, totalChunks, startSample, endSample, chunkChannelData } = data;
    
    // Validate trackId
    if (this.currentTrackId && trackId !== this.currentTrackId) {
      console.log(`[AudioWorklet] Rejecting chunk from wrong song: ${trackId} (current: ${this.currentTrackId})`);
      return;
    }
    
    // Check if we have chunked buffer state for this track
    const chunkedBuffer = this.pendingChunkedBuffers.get(trackId);
    if (!chunkedBuffer) {
      console.warn(`[AudioWorklet] Received chunk for unknown chunked buffer: ${trackId}`);
      return;
    }
    
    // Check for timeout (cleanup stale chunked buffers)
    const currentTime = Date.now();
    if (currentTime - chunkedBuffer.startTime > this.maxChunkAssemblyTime) {
      console.warn(`[AudioWorklet] Chunked buffer assembly timeout for ${trackId}`);
      this.clearChunkedBuffersForTrack(trackId);
      return;
    }
    
    // Validate chunk data
    if (chunkIndex < 0 || chunkIndex >= chunkedBuffer.metadata.totalChunks) {
      console.error(`[AudioWorklet] Invalid chunk index ${chunkIndex} for ${trackId}`);
      return;
    }
    
    if (chunkedBuffer.chunks.has(chunkIndex)) {
      console.warn(`[AudioWorklet] Duplicate chunk ${chunkIndex} for ${trackId}`);
      return;
    }
    
    // Validate channel data
    if (!chunkChannelData || chunkChannelData.length !== chunkedBuffer.metadata.numberOfChannels) {
      console.error(`[AudioWorklet] Invalid chunk channel data for ${trackId}, chunk ${chunkIndex}`);
      return;
    }
    
    // Copy chunk data into the complete buffer
    const chunkSize = endSample - startSample;
    for (let channel = 0; channel < chunkedBuffer.metadata.numberOfChannels; channel++) {
      const channelChunk = chunkChannelData[channel];
      if (channelChunk.length !== chunkSize) {
        console.error(`[AudioWorklet] Chunk size mismatch for ${trackId}, chunk ${chunkIndex}, channel ${channel}`);
        continue;
      }
      
      // Copy chunk data to the correct position in the complete buffer
      chunkedBuffer.channelData[channel].set(channelChunk, startSample);
    }
    
    // Mark chunk as received
    chunkedBuffer.chunks.set(chunkIndex, { startSample, endSample, received: true });
    chunkedBuffer.receivedChunks++;
    
    console.log(`[AudioWorklet] Received chunk ${chunkIndex + 1}/${totalChunks} for ${trackId} (${chunkedBuffer.receivedChunks}/${chunkedBuffer.metadata.totalChunks} total)`);
    
    // Check if all chunks are received
    if (chunkedBuffer.receivedChunks >= chunkedBuffer.metadata.totalChunks) {
      this.finalizeChunkedBuffer(trackId);
    }
  }
  
  // Finalize chunked buffer assembly and schedule for progressive switching
  finalizeChunkedBuffer(trackId) {
    const chunkedBuffer = this.pendingChunkedBuffers.get(trackId);
    if (!chunkedBuffer) {
      console.error(`[AudioWorklet] Cannot finalize unknown chunked buffer: ${trackId}`);
      return;
    }
    
    const { metadata, channelData } = chunkedBuffer;
    
    // Validate that all chunks were received
    let missingChunks = [];
    for (let i = 0; i < metadata.totalChunks; i++) {
      if (!chunkedBuffer.chunks.has(i)) {
        missingChunks.push(i);
      }
    }
    
    if (missingChunks.length > 0) {
      console.error(`[AudioWorklet] Missing chunks for ${trackId}: ${missingChunks.join(', ')}`);
      this.clearChunkedBuffersForTrack(trackId);
      return;
    }
    
    // Create buffer data for progressive scheduling
    const bufferData = {
      trackId: metadata.trackId,
      channelData: channelData,
      sampleRate: metadata.sampleRate,
      numberOfChannels: metadata.numberOfChannels,
      totalSamples: metadata.totalSamples,
      duration: metadata.duration,
      switchTime: metadata.switchTime,
      earlyStopTime: metadata.earlyStopTime
    };
    
    // Add to scheduled buffers
    this.scheduledBuffers.push(bufferData);
    
    // Update next switch time if this is the next buffer to switch to
    if (this.scheduledBuffers.length === this.currentBufferIndex + 1) {
      this.nextSwitchTime = bufferData.switchTime;
      // If switchTime is 0, this buffer is immediately active
      if (bufferData.switchTime === 0) {
        console.log(`[AudioWorklet] Chunked buffer 0 is immediately active, setting as current buffer`);
        this.currentBufferIndex = 0;
        this.nextSwitchTime = null; // Will be set when next buffer is scheduled
      }
    }
    
    console.log(`[AudioWorklet] ✅ Finalized chunked buffer for ${trackId} (${metadata.totalChunks} chunks assembled, duration: ${metadata.duration}s, switch time: ${metadata.switchTime}s)`);
    console.log(`[AudioWorklet] Progressive buffer status: ${this.scheduledBuffers.length} buffers for trackId ${this.currentTrackId}, current index: ${this.currentBufferIndex}, next switch: ${this.nextSwitchTime}`);
    
    // Clean up chunked buffer state
    this.clearChunkedBuffersForTrack(trackId);
  }
  
  // Clear chunked buffer state for a specific track
  clearChunkedBuffersForTrack(trackId) {
    if (!trackId) return;
    
    // Clear pending chunked buffer
    if (this.pendingChunkedBuffers.has(trackId)) {
      this.pendingChunkedBuffers.delete(trackId);
      console.log(`[AudioWorklet] Cleared pending chunked buffer for ${trackId}`);
    }
  }
  
  // iOS Safari sample rate adjustment - FIXED: Prevent cumulative drift and maintain audio data integrity
  adjustTimingForSampleRateChange(oldSampleRate, newSampleRate) {
    if (!oldSampleRate || !newSampleRate || oldSampleRate === newSampleRate) {
      return;
    }
    
    const ratioCorrection = oldSampleRate / newSampleRate;
    
    // CRITICAL FIX: Use precise floating point calculations, not Math.floor() truncation
    // This prevents cumulative drift that causes pitch/speed issues
    const currentSamples = this.bufferSourcePosition;
    this.bufferSourcePosition = Math.round(currentSamples * ratioCorrection);
    this.currentTime = this.bufferSourcePosition / newSampleRate;
    
    // CRITICAL FIX: DO NOT modify totalSamples - it represents the original audio data
    // Only update timing calculations, not the source data properties
    if (this.sampleRate) {
      // Update current sample rate for timing calculations
      this.sampleRate = newSampleRate;
      
      // Recalculate duration based on original totalSamples and new sample rate
      if (this.totalSamples) {
        this.duration = this.totalSamples / newSampleRate;
      }
    }
    
    // Adjust early stop time based on new duration
    if (this.currentBufferEarlyStopTime && this.duration) {
      this.currentBufferEarlyStopTime = Math.max(0, this.duration - 0.75);
    }
    
    console.log(`[AudioWorklet] iOS timing adjusted for sample rate change: ${oldSampleRate}Hz → ${newSampleRate}Hz, position=${this.currentTime.toFixed(3)}s, duration=${this.duration.toFixed(3)}s`);
  }
}

registerProcessor('audio-playback-processor', AudioPlaybackProcessor);