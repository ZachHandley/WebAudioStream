// CLI library exports for programmatic usage

export interface DeployOptions {
  dest?: string;
  filename?: string;
}

export interface CheckResult {
  passed: boolean;
  message: string;
  fix?: string;
}

/**
 * Deploy audio worklet processor to a directory
 */
export async function deployWorklet(options: DeployOptions = {}): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  
  const dest = options.dest || 'public';
  const filename = options.filename || 'audio-worklet-processor.js';
  
  const cmd = `npx web-audio-stream-cli deploy --dest "${dest}" --filename "${filename}"`;
  
  try {
    await execAsync(cmd);
  } catch (error) {
    throw new Error(`Failed to deploy worklet: ${error}`);
  }
}

/**
 * Check project setup for Web Audio Stream
 */
export async function checkSetup(options: DeployOptions = {}): Promise<CheckResult[]> {
  const { existsSync } = await import('fs');
  const { resolve } = await import('path');
  
  const dest = options.dest || 'public';
  const filename = options.filename || 'audio-worklet-processor.js';
  
  const checks: Array<{ name: string; check: () => boolean; fix: string }> = [
    {
      name: 'web-audio-stream package installed',
      check: () => existsSync(resolve(process.cwd(), 'node_modules/web-audio-stream')),
      fix: 'Run: npm install web-audio-stream'
    },
    {
      name: 'Public directory exists',
      check: () => existsSync(resolve(process.cwd(), dest)),
      fix: `Create directory: mkdir ${dest}`
    },
    {
      name: 'Audio worklet file deployed',
      check: () => existsSync(resolve(process.cwd(), dest, filename)),
      fix: 'Run: web-audio-stream-cli deploy'
    }
  ];
  
  return checks.map(check => ({
    passed: check.check(),
    message: check.name,
    fix: check.fix
  }));
}

export default {
  deployWorklet,
  checkSetup
};