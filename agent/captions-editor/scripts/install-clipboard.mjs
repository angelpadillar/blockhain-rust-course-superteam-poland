import { readFile, writeFile, copyFile } from 'node:fs/promises';
const root = process.argv[2] || '/usr/share/novnc';
const htmlFile = root + '/vnc.html';
let html = await readFile(htmlFile, 'utf8');
if (!html.includes('buena-clipboard.js')) {
  if (!html.includes('</head>')) throw Error('Expected noVNC HTML head');
  html = html.replace('</head>', '    <link rel="stylesheet" href="app/buena-clipboard.css?v=1">\n    <script type="module" src="app/buena-clipboard.js?v=1"></script>\n</head>');
}
await copyFile(new URL('../novnc/buena-clipboard.js', import.meta.url), root + '/app/buena-clipboard.js');
await copyFile(new URL('../novnc/buena-clipboard.css', import.meta.url), root + '/app/buena-clipboard.css');
await writeFile(htmlFile, html);
