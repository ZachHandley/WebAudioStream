---
'z-web-audio-stream': minor
'z-astro-web-audio-stream': minor
---

Add custom obfuscation key support for enhanced privacy

- Added obfuscationKey option to WebAudioManagerOptions for custom privacy keys
- Users can now set their own obfuscation key instead of using the default hardcoded key
- Enhanced privacy with app-specific data isolation in IndexedDB storage
- Added obfuscation key support to setupWebAudio() and setupInstantAudio() functions
- Backward compatible with existing cached data using default obfuscation key
- Updated documentation with privacy examples and usage guide