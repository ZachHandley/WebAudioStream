# z-z-z-web-audio-stream-cli

CLI tool for deploying Web Audio Stream worklet files to your project.

## 📦 Installation

```bash
npm install -g z-z-web-audio-stream-cli
# or use without installing
npx z-z-web-audio-stream-cli
```

## 🚀 Commands

### Deploy Worklet

Copy the audio worklet processor to your public directory:

```bash
z-z-web-audio-stream-cli deploy
# or short form
was-cli deploy

# Custom destination
z-z-web-audio-stream-cli deploy --dest public --filename audio-worklet-processor.js
```

**Options:**
- `-d, --dest <path>` - Destination directory (default: `public`)
- `-f, --filename <name>` - Output filename (default: `audio-worklet-processor.js`)

### Check Setup

Validate your project setup:

```bash
z-z-web-audio-stream-cli check
```

This verifies:
- ✅ `z-web-audio-stream` package is installed
- ✅ Public directory exists
- ✅ Audio worklet file is deployed

### Show Information

Display package info and iOS Safari optimizations:

```bash
z-z-web-audio-stream-cli info
```

## 🔧 Programmatic Usage

You can also use the CLI functions programmatically:

```typescript
import { deployWorklet, checkSetup } from 'z-z-web-audio-stream-cli';

// Deploy worklet
await deployWorklet({
  dest: 'public',
  filename: 'audio-worklet-processor.js'
});

// Check setup
const results = await checkSetup();
for (const result of results) {
  console.log(`${result.passed ? '✅' : '❌'} ${result.message}`);
  if (!result.passed && result.fix) {
    console.log(`   Fix: ${result.fix}`);
  }
}
```

## 🍎 Why This CLI?

Web Audio Stream fixes critical iOS Safari issues:

1. **Sample Rate Mismatches** - Causes high-pitched/fast audio
2. **Memory Pressure** - Large files cause page reloads  
3. **IndexedDB Failures** - Safari randomly fails connections
4. **Broken AudioContext** - Requires special reset patterns

The CLI ensures the iOS-safe audio worklet is properly deployed to your project.

## 📋 Typical Workflow

1. **Install the package:**
   ```bash
   npm install z-web-audio-stream
   ```

2. **Deploy the worklet:**
   ```bash
   npx z-z-web-audio-stream-cli deploy
   ```

3. **Use in your app:**
   ```typescript
   import { setupWebAudio } from 'z-web-audio-stream';
   
   const manager = await setupWebAudio({
     workletPath: '/audio-worklet-processor.js'
   });
   
   await manager.loadAndPlay('/audio/song.mp3', 'song-1');
   ```

4. **Verify setup:**
   ```bash
   npx z-z-web-audio-stream-cli check
   ```

## 🔍 Troubleshooting

**"Could not find audio worklet processor file"**
- Make sure `z-web-audio-stream` is installed: `npm install z-web-audio-stream`
- Try running from your project root directory

**"Permission denied"**
- Make sure you have write access to the destination directory
- Try running with `sudo` if necessary

**CLI not found**
- Install globally: `npm install -g z-z-web-audio-stream-cli`
- Or use npx: `npx z-z-web-audio-stream-cli`

## 📄 License

MIT License - Part of the Web Audio Stream package suite.