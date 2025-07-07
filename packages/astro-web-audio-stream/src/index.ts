// Astro integration for Web Audio Stream

import type { AstroIntegration } from 'astro';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

export interface WebAudioStreamOptions {
  /**
   * Path where the audio worklet will be served from
   * @default '/audio-worklet-processor.js'
   */
  workletPath?: string;
  
  /**
   * Public directory path relative to project root
   * @default 'public'
   */
  publicDir?: string;
  
  /**
   * Whether to automatically copy the worklet file during build
   * @default true
   */
  autoDeploy?: boolean;
  
  /**
   * Log deployment information
   * @default true
   */
  verbose?: boolean;
}

/**
 * Astro integration for Web Audio Stream
 * 
 * Automatically deploys the iOS Safari-safe audio worklet processor
 * to your public directory during build.
 */
export default function webAudioStream(options: WebAudioStreamOptions = {}): AstroIntegration {
  const {
    workletPath = '/audio-worklet-processor.js',
    publicDir = 'public',
    autoDeploy = true,
    verbose = true
  } = options;

  return {
    name: '@web-audio-stream/astro',
    
    hooks: {
      'astro:config:setup': ({ config, logger }) => {
        if (verbose) {
          logger.info('🎵 Web Audio Stream integration loaded');
          logger.info('🍎 iOS Safari audio fixes will be applied automatically');
        }
        
        // Ensure the worklet path is correctly configured
        if (!workletPath.startsWith('/')) {
          throw new Error('@web-audio-stream/astro: workletPath must start with "/"');
        }
      },
      
      'astro:config:done': ({ config, logger }) => {
        if (!autoDeploy) {
          if (verbose) {
            logger.info('Auto-deploy disabled. Run `npx web-audio-stream-cli deploy` manually.');
          }
          return;
        }
        
        try {
          // Find the worklet file from z-web-audio-stream package
          let workletSource: string;
          
          // Try to find it in node_modules
          const nodeModulesPath = resolve(config.root.pathname, 'node_modules/z-web-audio-stream/dist/audio-worklet-processor.js');
          if (existsSync(nodeModulesPath)) {
            workletSource = readFileSync(nodeModulesPath, 'utf8');
          } else {
            throw new Error('Could not find z-web-audio-stream package. Please install it: npm install z-web-audio-stream');
          }
          
          // Determine output path
          const publicPath = resolve(config.root.pathname, publicDir);
          const outputPath = join(publicPath, workletPath.replace(/^\//, ''));
          
          // Ensure public directory exists
          if (!existsSync(publicPath)) {
            mkdirSync(publicPath, { recursive: true });
            if (verbose) {
              logger.info(`Created public directory: ${publicPath}`);
            }
          }
          
          // Write worklet file
          writeFileSync(outputPath, workletSource);
          
          if (verbose) {
            logger.info(`✅ Audio worklet deployed to: ${outputPath}`);
            logger.info(`🔧 Use in your app: setupWebAudio({ workletPath: "${workletPath}" })`);
          }
          
        } catch (error) {
          logger.error(`❌ Failed to deploy audio worklet: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
      
      'astro:build:start': ({ logger }) => {
        if (verbose) {
          logger.info('🍎 Building with iOS Safari audio optimizations');
        }
      }
    }
  };
}