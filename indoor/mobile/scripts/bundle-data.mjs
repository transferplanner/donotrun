#!/usr/bin/env node
// Bundle pipeline outputs into www/data/ so the Capacitor app works offline.
//
// Layout produced:
//   www/data/stations.json        — list of {file, name}
//   www/data/graph/<file>         — merged/reviewed/final station JSON
//   www/data/fingerprints.json    — list of fingerprint filenames
//   www/data/fingerprint/<file>   — fingerprint JSON
//   www/data/floor-map.json       — _floor_map.json
//   www/data/image/<hash>.jpg     — downscaled JPEG for each referenced floor image
//
// Keeps the same logical paths the dev HTTP server exposed, so user.html can
// be retargeted with a simple base-URL swap.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const OUT_DIR = path.resolve(ROOT, 'mobile/www/data');
const OUTPUT = path.resolve(ROOT, 'data/output');
const RAW_MAPS = path.resolve(ROOT, 'data/raw_maps');

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function ensure(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function writeJson(p, v) {
  await fs.writeFile(p, JSON.stringify(v, null, 0));
}

function hashPath(rel) {
  return createHash('sha1').update(rel).digest('hex').slice(0, 16) + '.jpg';
}

async function convertImage(srcAbs, dstAbs) {
  // Use python+PIL to match the server's CMYK→RGB + thumbnail step. This
  // script stays pure JS but shells out for image work since node lacks a
  // built-in decoder for all formats Seoul metro ships.
  const py = `
import sys
from PIL import Image
img = Image.open(sys.argv[1])
if img.mode != 'RGB':
    img = img.convert('RGB')
img.thumbnail((1600, 1600), Image.LANCZOS)
img.save(sys.argv[2], 'JPEG', quality=82)
`;
  const r = spawnSync('python3', ['-c', py, srcAbs, dstAbs], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`image convert failed: ${srcAbs}`);
}

async function pickStationSource(fname) {
  for (const stage of ['final', 'reviewed', 'merged']) {
    const p = path.join(OUTPUT, stage, fname);
    try {
      await fs.access(p);
      return { p, stage };
    } catch {}
  }
  return null;
}

async function main() {
  await rmrf(OUT_DIR);
  await ensure(path.join(OUT_DIR, 'graph'));
  await ensure(path.join(OUT_DIR, 'fingerprint'));
  await ensure(path.join(OUT_DIR, 'image'));

  const merged = await fs.readdir(path.join(OUTPUT, 'merged')).catch(() => []);
  const stations = [];
  const imageMap = new Map(); // rel path → hashed filename
  const fileMap = {}; // original json name → ascii disk filename

  for (const fname of merged.sort()) {
    if (!fname.endsWith('.json')) continue;
    const src = await pickStationSource(fname);
    if (!src) continue;
    const data = await readJson(src.p);
    data._source_stage = src.stage;

    // Rewrite image paths to hashed local references
    for (const floor of data.floors || []) {
      const rel = floor.image || data._source_image;
      if (!rel) continue;
      if (!imageMap.has(rel)) {
        imageMap.set(rel, hashPath(rel));
      }
      floor._image_hash = imageMap.get(rel);
    }

    // Capacitor local server URL-decodes request paths and can't resolve
    // non-ASCII filenames. Store on disk under a SHA-based ASCII name; the
    // fetch-hook in user.html hashes the requested (decoded) filename to
    // find the file. stations.json keeps the Korean name so the dropdown
    // renders correctly.
    const asciiName = createHash('sha1').update(fname).digest('hex').slice(0, 12) + '.json';
    await writeJson(path.join(OUT_DIR, 'graph', asciiName), data);
    fileMap[fname] = asciiName;
    stations.push(fname);
  }

  await writeJson(path.join(OUT_DIR, 'stations.json'), { files: stations });

  // Fingerprints
  const fpDir = path.join(OUTPUT, 'fingerprints');
  const fpFiles = (await fs.readdir(fpDir).catch(() => []))
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();
  for (const fname of fpFiles) {
    const data = await readJson(path.join(fpDir, fname));
    const asciiName = createHash('sha1').update(fname).digest('hex').slice(0, 12) + '.json';
    await writeJson(path.join(OUT_DIR, 'fingerprint', asciiName), data);
    fileMap[fname] = asciiName;
  }
  await writeJson(path.join(OUT_DIR, 'fingerprints.json'), { files: fpFiles });
  await writeJson(path.join(OUT_DIR, 'files.json'), fileMap);

  const floorMapPath = path.join(fpDir, '_floor_map.json');
  try {
    await fs.copyFile(floorMapPath, path.join(OUT_DIR, 'floor-map.json'));
  } catch {
    await writeJson(path.join(OUT_DIR, 'floor-map.json'), {});
  }

  // Images
  for (const [rel, hashed] of imageMap) {
    const src = path.join(RAW_MAPS, rel);
    const dst = path.join(OUT_DIR, 'image', hashed);
    try {
      await convertImage(src, dst);
    } catch (err) {
      console.warn(`[bundle-data] skip image ${rel}: ${err.message}`);
    }
  }

  // Image manifest for runtime URL rewriting
  const imageManifest = {};
  for (const [rel, hashed] of imageMap) imageManifest[rel] = hashed;
  await writeJson(path.join(OUT_DIR, 'images.json'), imageManifest);

  // Copy UI assets (user.html + src/location/*.js) into www/,
  // rewriting dev-server paths and injecting the native bridge.
  const UI_SRC = path.resolve(ROOT, 'pipeline/review_ui/user.html');
  const UI_DST = path.resolve(ROOT, 'mobile/www/user.html');
  try {
    let html = await fs.readFile(UI_SRC, 'utf8');
    // Map dev-server JS paths to the bundled location
    html = html.replaceAll('/static/location/', './src/location/');
    // Synchronous fetch hook MUST run before any other script, including
    // non-module inline scripts. type="module" is deferred, so it loses the
    // race. Inline the hook + image manifest preload, then let the module
    // (nativeScan) lazy-load.
    const inlineHook = `
<script>
(function(){
  var DATA_BASE='./data';
  var imageManifest=${JSON.stringify(imageManifest)};
  var fileMap=${JSON.stringify(fileMap)};
  window.__DRI_IMAGE_MANIFEST = imageManifest;
  function lookupFile(encoded){
    var dec; try { dec = decodeURIComponent(encoded); } catch(e){ dec = encoded; }
    return fileMap[dec] || encoded;
  }
  var ROUTES=[
    {p:/^\\/api\\/stations\\/?$/,t:function(){return DATA_BASE+'/stations.json';}},
    {p:/^\\/api\\/station\\?f=(.+)$/,t:function(m){return DATA_BASE+'/graph/'+lookupFile(m[1]);}},
    {p:/^\\/api\\/graph\\?f=(.+)$/,t:function(m){return DATA_BASE+'/graph/'+lookupFile(m[1]);}},
    {p:/^\\/api\\/fingerprints\\/?$/,t:function(){return DATA_BASE+'/fingerprints.json';}},
    {p:/^\\/api\\/fingerprint\\?f=(.+)$/,t:function(m){return DATA_BASE+'/fingerprint/'+lookupFile(m[1]);}},
    {p:/^\\/api\\/floor-map\\/?$/,t:function(){return DATA_BASE+'/floor-map.json';}},
  ];
  function rewrite(url){
    var p = url.indexOf('http')===0 ? (new URL(url).pathname + (new URL(url).search||'')) : url;
    for (var i=0;i<ROUTES.length;i++){ var m=p.match(ROUTES[i].p); if(m) return ROUTES[i].t(m); }
    var im = p.match(/^\\/api\\/image\\?f=(.+)$/);
    if (im){ var rel=decodeURIComponent(im[1]); var h=imageManifest[rel]; if(h) return DATA_BASE+'/image/'+h; }
    return null;
  }
  var origFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    var url = (typeof input==='string') ? input : input.url;
    var t = rewrite(url);
    return origFetch(t || input, init);
  };
  // Preload image manifest (sync-ish via sync XHR would block; use fetch,
  // and temporarily queue /api/image until it lands)
  origFetch(DATA_BASE+'/images.json').then(function(r){return r.json();})
    .then(function(m){ imageManifest=m||{}; console.log('[bridge] images:', Object.keys(imageManifest).length); })
    .catch(function(e){ console.warn('[bridge] images.json load failed:', e); });
  window.__DRI_SIM_MODE = (function(){ try { return localStorage.getItem('dri.simMode')==='1'; } catch(e){ return false; } })();
  window.hasNativeScan = !window.__DRI_SIM_MODE;
  console.log('[bridge] installed, simMode=', window.__DRI_SIM_MODE);
})();
</script>
<script type="module" src="./src/native-bridge.js"></script>`;
    html = html.replace(/<head>/i, `<head>\n${inlineHook}`);
    await fs.writeFile(UI_DST, html, 'utf8');
  } catch (e) {
    console.warn('[bundle-data] user.html transform failed:', e.message);
  }

  const LOC_SRC = path.resolve(ROOT, 'src/location');
  const LOC_DST = path.resolve(ROOT, 'mobile/www/src/location');
  await ensure(LOC_DST);
  for (const f of await fs.readdir(LOC_SRC)) {
    if (f.endsWith('.js')) await fs.copyFile(path.join(LOC_SRC, f), path.join(LOC_DST, f));
  }

  const summary = {
    stations: stations.length,
    fingerprints: fpFiles.length,
    images: imageMap.size,
  };
  await writeJson(path.join(OUT_DIR, 'manifest.json'), summary);
  console.log('[bundle-data]', summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
