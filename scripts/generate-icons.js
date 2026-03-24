/**
 * Generate all required icon sizes for Hou.la Print from a source PNG.
 *
 * Usage:
 *   node scripts/generate-icons.js [source.png]
 *
 * If no source is specified, defaults to assets/icon-source.png
 *
 * Generates:
 *   assets/icon.png       — 512x512 (app icon, electron-builder)
 *   assets/icon.ico        — multi-size ICO (16/32/48/64/128/256) for Windows
 *   assets/tray-icon.png   — 16x16 (system tray on Windows)
 *   assets/icon-256.png    — 256x256 (fallback)
 *   assets/icon-128.png    — 128x128 (Linux)
 *   assets/icon-64.png     — 64x64
 *   assets/icon-32.png     — 32x32
 *   assets/icon-16.png     — 16x16
 */

const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');
const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');

async function main() {
  const sourcePath = process.argv[2] || path.join(ASSETS_DIR, 'icon-source.png');

  if (!fs.existsSync(sourcePath)) {
    console.error(`Source file not found: ${sourcePath}`);
    console.error('Usage: node scripts/generate-icons.js [path/to/source.png]');
    process.exit(1);
  }

  console.log(`Source: ${sourcePath}`);

  const sizes = [512, 256, 128, 64, 32, 16];

  // Generate PNGs at each size
  for (const size of sizes) {
    const outputName = size === 512 ? 'icon.png' : `icon-${size}.png`;
    const outputPath = path.join(ASSETS_DIR, outputName);
    await sharp(sourcePath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outputPath);
    console.log(`  ✓ ${outputName} (${size}x${size})`);
  }

  // Generate tray icon (16x16)
  const trayPath = path.join(ASSETS_DIR, 'tray-icon.png');
  await sharp(sourcePath)
    .resize(16, 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(trayPath);
  console.log('  ✓ tray-icon.png (16x16)');

  // Generate ICO from multiple PNG sizes (for Windows)
  const icoSources = [256, 128, 64, 48, 32, 16];
  const tempPngs = [];

  for (const size of icoSources) {
    const tempPath = path.join(ASSETS_DIR, `_temp_${size}.png`);
    await sharp(sourcePath)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(tempPath);
    tempPngs.push(tempPath);
  }

  try {
    const icoBuffer = await pngToIco(tempPngs);
    const icoPath = path.join(ASSETS_DIR, 'icon.ico');
    fs.writeFileSync(icoPath, icoBuffer);
    console.log('  ✓ icon.ico (multi-size: 256/128/64/48/32/16)');
  } catch (err) {
    console.error('  ✗ icon.ico generation failed:', err.message);
  }

  // Cleanup temp files
  for (const tempPath of tempPngs) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }

  console.log('\nDone! All icons generated in assets/');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
