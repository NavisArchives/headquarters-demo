// Explicit public allowlist: private Gmail credentials and progress never enter assets.
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const source = new URL('../modules/leads/', import.meta.url);
const target = new URL('../src/public/assets/leads/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const file of ['assets/app.js', 'assets/app.css', 'assets/outreach.js', 'assets/email-template.js', 'assets/tracking.js', 'assets/gmail-setup.js', 'gmail-setup.html']) cpSync(new URL(file, source), new URL(file, target), { recursive: true });
let html = readFileSync(new URL('index.html', source), 'utf8');
html = html.replace('<script src="datasets/_all.js"></script>', '').replace('<script src="assets/app.js"></script>', '<script src="assets/hq-bridge.js"></script>');
writeFileSync(new URL('index.html', target), html);
cpSync(new URL('assets/hq-bridge.js', source), new URL('assets/hq-bridge.js', target));
console.log('Built the full Leads workspace into HQ assets.');
