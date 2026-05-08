#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * esbuild bundle script for the extension.
 *   - Emits background.js / content.js / sidebar.js / options.js into dist/
 *   - Copies manifest.json + sidebar.html + sidebar.css + options.html as-is
 */
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const entries = {
  background: 'src/background.ts',
  content: 'src/content.ts',
  sidebar: 'src/sidebar.ts',
  options: 'src/options.ts',
};

const buildOpts = (name, entry) => ({
  entryPoints: [path.join(root, entry)],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['chrome116'],
  outfile: path.join(out, `${name}.js`),
  legalComments: 'none',
  logLevel: 'info',
  tsconfig: path.join(root, 'tsconfig.json'),
});

(async () => {
  for (const [name, entry] of Object.entries(entries)) {
    await esbuild.build(buildOpts(name, entry));
  }

  // Static assets
  const publicDir = path.join(root, 'public');
  for (const f of fs.readdirSync(publicDir)) {
    const src = path.join(publicDir, f);
    const dst = path.join(out, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
  }

  // Placeholder icons (1×1 transparent PNGs) so the manifest validates without
  // shipping artwork. Replaced before public release.
  const iconsOut = path.join(out, 'icons');
  fs.mkdirSync(iconsOut, { recursive: true });
  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64',
  );
  for (const size of ['16', '48', '128']) {
    fs.writeFileSync(path.join(iconsOut, `icon${size}.png`), tinyPng);
  }

  console.log(`built → ${out}`);
})();
