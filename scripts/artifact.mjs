// Package dist/wildlight-tactics.html for publishing as a claude.ai artifact:
// the host supplies the document skeleton (doctype, head, viewport), so emit
// only <title>, styles and body content; escape U+FFFD (the host refuses it
// in source) and size the app to the host's padded root instead of 100dvh.
import { readFileSync, writeFileSync } from 'node:fs';

const src = new URL('../dist/wildlight-tactics.html', import.meta.url).pathname;
const out = new URL('../dist/artifact.html', import.meta.url).pathname;
const html = readFileSync(src, 'utf8');
if (/sk-ant-/.test(html)) throw new Error('Refusing to package: an API key is in the bundle');
let head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
head = head.replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '');
const title = head.match(/<title>.*?<\/title>/)[0];
head = head.replace(title, '');
const fit = '<style>html,body{height:100%;background:#0b0f1a}#app{height:100%}.game{padding:0}.screen{padding-top:16px;padding-bottom:24px}</style>';
// U+FFFD only appears inside JS string/template literals in the bundle, where � is equivalent.
const page = `${title}\n${head.trim()}\n${fit}\n${body.trim()}\n`.replaceAll('�', '\\uFFFD');
writeFileSync(out, page);
console.log(`dist/artifact.html  ${(page.length / 1024).toFixed(0)} KB`);
