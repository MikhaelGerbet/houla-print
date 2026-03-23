/**
 * Copy renderer files (HTML, CSS, JS) to dist/renderer/
 * Since the renderer is plain HTML/CSS/JS (no TypeScript), we just copy it.
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
