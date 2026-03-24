/**
 * Development script: build TypeScript + launch Electron in dev mode.
 */
const { spawn } = require('child_process');
const path = require('path');

const rootDir = path.join(__dirname, '..');
let electronProcess = null;

function build() {
  return new Promise((resolve, reject) => {
    console.log('[Dev] Building TypeScript...');
    const proc = spawn('npm', ['run', 'build'], {
      cwd: rootDir,
      shell: true,
      stdio: 'inherit',
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });
}

function startElectron() {
  if (electronProcess) {
    console.log('[Dev] Killing previous Electron...');
    electronProcess.kill();
  }
  console.log('[Dev] Starting Electron...');
  electronProcess = spawn('npx', ['electron', 'dist/main/index.js', '--dev'], {
    cwd: rootDir,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  electronProcess.on('close', () => {
    console.log('[Dev] Electron closed.');
    process.exit(0);
  });
}

(async () => {
  try {
    await build();
    startElectron();
  } catch (err) {
    console.error('[Dev] Build failed:', err.message);
    process.exit(1);
  }
})();
