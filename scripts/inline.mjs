// Bundle dist/ into one self-contained HTML file (dist/wildlight-tactics.html)
// so a build can be shared or opened from anywhere without a server.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
let html = readFileSync(join(dist, 'index.html'), 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/, (_, f) => {
  const js = readFileSync(join(dist, f), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/, (_, f) => `<style>${readFileSync(join(dist, f), 'utf8')}</style>`);
if (/src="\.\/|href="\.\//.test(html)) throw new Error('Unresolved asset reference left in HTML');
writeFileSync(join(dist, 'wildlight-tactics.html'), html);
console.log(`dist/wildlight-tactics.html  ${(html.length / 1024).toFixed(0)} KB`);
