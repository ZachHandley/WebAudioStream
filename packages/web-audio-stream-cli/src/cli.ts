#!/usr/bin/env node
// CLI for deploying Web Audio Stream worklet files

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const program = new Command();

// Get version from package.json
const packageJsonPath = resolve(__dirname, '../package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

program
  .name('z-web-audio-stream-cli')
  .description('CLI tool for deploying Web Audio Stream worklet files')
  .version(packageJson.version);

// Deploy command - copies worklet file to public directory
program
  .command('deploy')
  .description('Deploy audio worklet processor to public directory')
  .option('-d, --dest <path>', 'destination directory', 'public')
  .option('-f, --filename <name>', 'output filename', 'audio-worklet-processor.js')
  .action(async (options) => {
    const spinner = ora('Deploying audio worklet processor...').start();
    
    try {
      // Find the worklet file from z-web-audio-stream package
      let workletSource: string | undefined;
      let workletPath: string;
      
      try {
        // First try to resolve the package using Node's module resolution
        const packagePath = require.resolve('z-web-audio-stream/package.json');
        const packageDir = dirname(packagePath);
        workletPath = join(packageDir, 'dist/audio-worklet-processor.js');
        
        if (existsSync(workletPath)) {
          workletSource = readFileSync(workletPath, 'utf8');
        } else {
          throw new Error('Worklet file not found in package dist');
        }
      } catch (resolveError) {
        // Fallback: try common locations
        const locations = [
          resolve(process.cwd(), 'node_modules/z-web-audio-stream/dist/audio-worklet-processor.js'),
          resolve(process.cwd(), '../node_modules/z-web-audio-stream/dist/audio-worklet-processor.js'),
        ];
        
        let found = false;
        for (const location of locations) {
          if (existsSync(location)) {
            workletPath = location;
            workletSource = readFileSync(location, 'utf8');
            found = true;
            break;
          }
        }
        
        if (!found) {
          throw new Error(
            'Could not find z-web-audio-stream package. Please ensure it is installed:\n' +
            'npm install z-web-audio-stream'
          );
        }
      }
      
      // Ensure we have the worklet source
      if (!workletSource) {
        throw new Error('Failed to load worklet source');
      }
      
      // Ensure destination directory exists
      const destDir = resolve(process.cwd(), options.dest);
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
        spinner.text = `Created directory: ${destDir}`;
      }
      
      // Write worklet file
      const destPath = join(destDir, options.filename);
      writeFileSync(destPath, workletSource);
      
      spinner.succeed(chalk.green(`✅ Audio worklet deployed to: ${destPath}`));
      
      console.log(chalk.blue('\n📋 Next steps:'));
      console.log(chalk.gray('1. Import WebAudioManager in your app:'));
      console.log(chalk.cyan('   import { setupWebAudio } from "z-web-audio-stream";'));
      console.log(chalk.gray('2. Initialize with the worklet path:'));
      console.log(chalk.cyan(`   const manager = await setupWebAudio({ workletPath: "/${options.filename}" });`));
      
    } catch (error) {
      spinner.fail(chalk.red(`❌ Deployment failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  });

// Info command - shows package information  
program
  .command('info')
  .description('Show package information and iOS Safari optimizations')
  .action(() => {
    console.log(chalk.blue.bold('🎵 Web Audio Stream'));
    console.log(chalk.gray(`Version: ${packageJson.version}`));
    console.log(chalk.gray('iOS Safari-safe Web Audio streaming with progressive loading\n'));
    
    console.log(chalk.green.bold('✨ Features:'));
    console.log(chalk.green('  • 🍎 iOS Safari pitch/speed issue fixes'));
    console.log(chalk.green('  • ⚡ Progressive loading with instant playback'));
    console.log(chalk.green('  • 💾 Smart IndexedDB caching with Safari retry logic'));
    console.log(chalk.green('  • 📱 Memory-safe chunking to prevent page reloads'));
    console.log(chalk.green('  • 🔊 AudioWorklet-based high-performance playback'));
    
    console.log(chalk.yellow.bold('\n🍎 iOS Safari Issues Fixed:'));
    console.log(chalk.yellow('  • Sample rate mismatches causing high-pitched audio'));
    console.log(chalk.yellow('  • Memory pressure from large files causing page reloads'));
    console.log(chalk.yellow('  • IndexedDB connection failures on first try'));
    console.log(chalk.yellow('  • Broken AudioContext state detection and recovery'));
    
    console.log(chalk.blue.bold('\n📖 Usage:'));
    console.log(chalk.cyan('  z-web-audio-stream-cli deploy     # Deploy worklet to public/'));
    console.log(chalk.cyan('  z-web-audio-stream-cli info       # Show this information'));
    console.log(chalk.cyan('  z-web-audio-stream-cli --help     # Show all commands'));
  });

// Check command - validates project setup
program
  .command('check')
  .description('Check project setup and worklet deployment')
  .option('-d, --dest <path>', 'public directory to check', 'public')
  .option('-f, --filename <name>', 'worklet filename to check', 'audio-worklet-processor.js')
  .action((options) => {
    console.log(chalk.blue.bold('🔍 Checking Web Audio Stream setup...\n'));
    
    const checks = [
      {
        name: 'z-web-audio-stream package installed',
        check: () => {
          try {
            require.resolve('z-web-audio-stream');
            return true;
          } catch {
            return existsSync(resolve(process.cwd(), 'node_modules/z-web-audio-stream'));
          }
        },
        fix: 'Run: npm install z-web-audio-stream'
      },
      {
        name: 'Public directory exists',
        check: () => existsSync(resolve(process.cwd(), options.dest)),
        fix: `Create directory: mkdir ${options.dest}`
      },
      {
        name: 'Audio worklet file deployed',
        check: () => existsSync(resolve(process.cwd(), options.dest, options.filename)),
        fix: 'Run: z-web-audio-stream-cli deploy'
      }
    ];
    
    let allPassed = true;
    
    for (const check of checks) {
      const passed = check.check();
      if (passed) {
        console.log(chalk.green(`✅ ${check.name}`));
      } else {
        console.log(chalk.red(`❌ ${check.name}`));
        console.log(chalk.gray(`   Fix: ${check.fix}`));
        allPassed = false;
      }
    }
    
    console.log();
    if (allPassed) {
      console.log(chalk.green.bold('🎉 All checks passed! Your project is ready for Web Audio Stream.'));
      console.log(chalk.blue('\n📖 Quick start:'));
      console.log(chalk.cyan('import { setupWebAudio } from "z-web-audio-stream";'));
      console.log(chalk.cyan('const manager = await setupWebAudio();'));
      console.log(chalk.cyan('await manager.loadAndPlay("/audio/song.mp3", "song-1");'));
    } else {
      console.log(chalk.red.bold('❌ Some checks failed. Please fix the issues above.'));
      process.exit(1);
    }
  });

program.parse();