/**
 * Copy renderer files (HTML, CSS, JS) to dist/renderer/
 * Since the renderer is plain HTML/CSS/JS (no TypeScript), we just copy it.
 * Also copies assets/ to dist/assets/ (logos, icons, etc.)
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dest = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(dest, { recursive: true });

const files = fs.readdirSync(src);
for (const file of files) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}

console.log(`Copied ${files.length} renderer files to dist/renderer/`);

// Copy assets/ to dist/assets/
const assetsSrc = path.join(__dirname, '..', 'assets');
const assetsDest = path.join(__dirname, '..', 'dist', 'assets');

if (fs.existsSync(assetsSrc)) {
  fs.mkdirSync(assetsDest, { recursive: true });
  const assetFiles = fs.readdirSync(assetsSrc);
  for (const file of assetFiles) {
    const srcFile = path.join(assetsSrc, file);
    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, path.join(assetsDest, file));
    }
  }
  console.log(`Copied ${assetFiles.length} asset files to dist/assets/`);
}
