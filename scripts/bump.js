#!/usr/bin/env node

/**
 * Version bump script for houla-print.
 *
 * Usage:
 *   node scripts/bump.js          # patch bump (1.0.2 → 1.0.3)
 *   node scripts/bump.js minor    # minor bump (1.0.2 → 1.1.0)
 *   node scripts/bump.js major    # major bump (1.0.2 → 2.0.0)
 *
 * What it does:
 *   1. Bumps version in package.json + package-lock.json
 *   2. Commits "chore: bump version to X.Y.Z"
 *   3. Creates git tag vX.Y.Z
 *   4. Pushes commit + tag to origin (triggers CI draft release)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const type = process.argv[2] || 'patch';
const validTypes = ['patch', 'minor', 'major'];

if (!validTypes.includes(type)) {
  console.error(`Invalid bump type: "${type}". Use: patch, minor, major`);
  process.exit(1);
}

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

// Read current version
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
const parts = oldVersion.split('.').map(Number);

// Bump
if (type === 'major') {
  parts[0]++;
  parts[1] = 0;
  parts[2] = 0;
} else if (type === 'minor') {
  parts[1]++;
  parts[2] = 0;
} else {
  parts[2]++;
}
const newVersion = parts.join('.');
const tag = `v${newVersion}`;

// Write package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Write package-lock.json
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = newVersion;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = newVersion;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

console.log(`\n  ${oldVersion} → ${newVersion}\n`);

// Git commit + tag + push
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

run('git add package.json package-lock.json');
run(`git commit -m "chore: bump version to ${newVersion}"`);
run(`git tag ${tag}`);
run(`git push origin master --tags`);

console.log(`\n  Tag ${tag} pushed — CI will build and create a draft release.\n`);
