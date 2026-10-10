import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourcePath = path.join(__dirname, 'index.js');
const runtimePath = path.join(__dirname, 'index.runtime.js');

const source = fs.readFileSync(sourcePath, 'utf8');

const oldBlock = `  let basePanel = null;
  let panelError = null;
  for (let attempt = 0; attempt < 3 && !basePanel; attempt++) {
    try { basePanel = await generatePanel(); }
    catch (e) {
      panelError = e;
      if (!e?.retryablePhotoLookup) throw e;
      console.warn(\`Celebrity photo panel retry \${attempt + 1}/3: \${e.message}\`);
    }
  }
  if (!basePanel) throw panelError || new Error('Could not build celebrity panel');
  if (basePanel.some(p => !p?.imageUrl || p.approvedPortrait !== true)) {
    const error = new Error('Six approved color celebrity portraits are required before the game can start. Please try again shortly.');
    error.retryablePhotoLookup = true;
    throw error;
  }`;

const newBlock = `  // If all six panel seats are occupied by human players, no celebrity-photo
  // lookup is needed. Build lightweight templates locally and immediately
  // replace them with the participants' uploaded photos below. This prevents
  // Wikipedia/photo availability from blocking an all-human family game.
  let basePanel = null;
  if (humanCelebIds.length >= 6) {
    basePanel = Array.from({ length: 6 }, (_, i) => ({
      ...MODERN_PANEL_BACKUPS[i % MODERN_PANEL_BACKUPS.length],
      imageUrl: null,
      approvedPortrait: false,
    }));
    console.log('All six celebrity seats are human; skipping external celebrity photo lookup.');
  } else {
    let panelError = null;
    for (let attempt = 0; attempt < 3 && !basePanel; attempt++) {
      try { basePanel = await generatePanel(); }
      catch (e) {
        panelError = e;
        if (!e?.retryablePhotoLookup) throw e;
        console.warn(\`Celebrity photo panel retry \${attempt + 1}/3: \${e.message}\`);
      }
    }
    if (!basePanel) throw panelError || new Error('Could not build celebrity panel');
    if (basePanel.some(p => !p?.imageUrl || p.approvedPortrait !== true)) {
      const error = new Error('Six approved color celebrity portraits are required before the game can start. Please try again shortly.');
      error.retryablePhotoLookup = true;
      throw error;
    }
  }`;

if (!source.includes(oldBlock)) {
  console.error('Runtime patch failed: expected celebrity-panel block was not found.');
  process.exit(1);
}

fs.writeFileSync(runtimePath, source.replace(oldBlock, newBlock), 'utf8');
await import(`./index.runtime.js?patched=${Date.now()}`);
