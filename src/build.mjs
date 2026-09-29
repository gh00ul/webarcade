// Assembles template.html + parts/*.js (in filename order) into ONE index.html.
//   node build.mjs <workdir> [--test] [--out <file>]
// --test : keeps `//@@DEBUG` lines (window.__dbg etc.) and points the import map at the local server's /three/ route.
// prod   : strips every line containing `//@@DEBUG`.
// A part may declare extra imports with a line:  //@@import import { X } from 'three/addons/...';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';

export function build(dir, { test = false, three = '/three/' } = {}) {
  const tpl = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
  const partsDir = path.join(dir, 'parts');
  const files = fs.readdirSync(partsDir).filter((f) => f.endsWith('.js')).sort();
  const imports = [];
  const bodies = [];
  for (const f of files) {
    let src = fs.readFileSync(path.join(partsDir, f), 'utf8');
    src = src.replace(/^\/\/@@import (.*)$/gm, (_, line) => { imports.push(line.trim()); return ''; });
    bodies.push(src.trim());
  }
  let code = bodies.join('\n\n');
  if (!test) code = code.split('\n').filter((l) => !l.includes('//@@DEBUG')).join('\n');
  const uniqueImports = [...new Set(imports)].filter((l) => !tpl.includes(l));
  let html = tpl.replace('//@@IMPORTS@@', uniqueImports.join('\n')).replace('//@@PARTS@@', () => code);
  if (test) html = html.split(CDN).join(three);
  return html;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
  const test = args.includes('--test');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : path.join(dir, 'dist', test ? 'test.html' : 'index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build(dir, { test }));
  console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1) + ' KB');
}
