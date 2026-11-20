// Writes docs/voice-studio-faq.html: a self-contained Voice Studio FAQ +
// consent handout for the Digital Learning website, rendered from the same
// text the recording portal shows (client/src/studio/faqContent.js).
// Usage: node scripts/build-voice-studio-faq.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = await import(pathToFileURL(path.join(root, 'client/src/studio/faqContent.js')).href);
const esc = (text) => String(text).replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const faq = content.FAQ.map((group) => `
    <h2>${esc(group.group)}</h2>
    ${group.items.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n    ')}`).join('\n');
const consent = content.CONSENT_SECTIONS.map((section) => `
      <h3>${esc(section.title)}</h3>
      <ul>${section.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`).join('');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice Studio FAQ</title>
<style>
  :root { --ink:#0f172a; --muted:#475569; --line:#e2e8f0; --bg:#f8fafc; --card:#fff; --accent:#1d4ed8; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e2e8f0; --muted:#94a3b8; --line:#334155; --bg:#0b1220; --card:#111a2e; --accent:#93c5fd; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 40px 16px 64px; }
  .eyebrow { color:var(--accent); font-size:12px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; margin:0; }
  h1 { font-size: clamp(26px, 4vw, 34px); line-height:1.2; margin:8px 0 12px; }
  .lead { color:var(--muted); margin:0 0 28px; }
  h2 { font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:32px 0 10px; }
  details { background:var(--card); border:1px solid var(--line); border-radius:12px; margin:8px 0; padding:0 16px; }
  summary { cursor:pointer; font-weight:600; padding:14px 0; }
  details p { margin:0 0 14px; color:var(--muted); }
  .consent { margin-top:40px; }
  .consent h3 { font-size:15px; margin:18px 0 4px; }
  .consent ul { margin:0; padding-left:20px; color:var(--muted); }
  .contact { margin-top:32px; padding:16px; border-radius:12px; background:var(--card); border:1px solid var(--line); }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <p class="eyebrow">LKCMedicine Voice Studio · Frequently asked questions</p>
  <h1>Your voice for LKCMedicine teaching</h1>
  <p class="lead">${esc(content.CONSENT_INTRO)}</p>
${faq}
  <details class="consent" open>
    <summary>Full consent form (version ${esc(content.CONSENT_VERSION)})</summary>
${consent}
  </details>
  <p class="contact">${esc(content.CONTACT_LINE)}</p>
</main>
</body>
</html>
`;
const out = path.join(root, 'docs', 'voice-studio-faq.html');
fs.writeFileSync(out, html);
console.log(`wrote ${out}`);
