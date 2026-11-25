// Builds the deployable site into dist/. Runs automatically before `npx wrangler deploy`
// (wrangler.jsonc "build.command"). No dependencies: plain Node.
//
//  - copies the site (minus what .assetsignore lists, plus tools/ and dist/)
//  - inlines style.css into index.html so first paint needs no extra request
//  - renders the guide pages in tools/pages.mjs to /<slug>/index.html
//  - writes sitemap.xml, robots.txt, llms.txt and _headers (cache + security headers)
//
// The repo root still works as-is with any static server for development; dist/ is only for deploys.
// Preview the built site: node tools/build.mjs && python -m http.server 5198 -d dist
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const SITE = 'https://useomniclip.com';
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- copy ----------
const ignore = new Set(['dist', 'tools', '.assetsignore', 'node_modules', 'package.json', 'package-lock.json']);
for (const line of readFileSync(join(ROOT, '.assetsignore'), 'utf8').split(/\r?\n/)) {
  const l = line.trim(); if (l && !l.startsWith('#')) ignore.add(l.replace(/\/$/, ''));
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const name of readdirSync(ROOT)) {
  if (ignore.has(name)) continue;
  cpSync(join(ROOT, name), join(OUT, name), { recursive: true });
}

// ---------- index.html: inline the stylesheet ----------
const css = readFileSync(join(ROOT, 'style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')       // comments
  .replace(/\s*\n\s*/g, '\n')              // indentation and blank lines
  .replace(/<\/style/gi, '<\\/style');
let index = readFileSync(join(ROOT, 'index.html'), 'utf8');
const link = /<link rel="stylesheet" href="style\.css">/;
if (!link.test(index)) throw new Error('build: style.css link not found in index.html');
index = index.replace(link, () => `<style>${css}</style>`);
writeFileSync(join(OUT, 'index.html'), index);

// ---------- guide pages ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (s) => String(s).replace(/<[^>]+>/g, '');
const LOGO = '<svg viewBox="0 0 16 26" aria-hidden="true"><rect x="1.2" y="1.2" width="13.6" height="23.6" rx="3.4" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M6.2 9.2v7.6l5.6-3.8z" fill="currentColor"/></svg>';
const PAGE_CSS = `@font-face{font-family:'Geist';src:url('/fonts/Geist-Variable.woff2') format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Geist Fallback';src:local('Arial'),local('ArialMT'),local('Liberation Sans'),local('Helvetica');size-adjust:101.1%;ascent-override:99.41%;descent-override:29.18%;line-gap-override:0%}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#0a0a0a;color:#f5f5f5;font:16px/1.6 'Geist','Geist Fallback',system-ui,sans-serif}
a{color:#fff;text-underline-offset:3px;text-decoration-color:rgba(255,255,255,.4)}a:hover{text-decoration-color:#fff}
:focus-visible{outline:2px solid #f5f5f5;outline-offset:2px}
.skip{position:absolute;left:12px;top:-40px;background:#f5f5f5;color:#000;padding:6px 12px;border-radius:8px}.skip:focus{top:8px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:820px;margin:0 auto;padding:16px 20px}
.brand{display:inline-flex;align-items:center;gap:3px;font-weight:700;letter-spacing:.06em;font-size:17px;text-decoration:none;color:#fff}
.brand svg{width:12px;height:19px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:999px;background:#f5f5f5;color:#0a0a0a;font-weight:600;font-size:15px;text-decoration:none}
.btn:hover{background:#fff}.btn.sm{min-height:36px;padding:0 14px;font-size:14px}
main{max-width:820px;margin:0 auto;padding:12px 20px 40px}
.crumbs{font-size:13px;color:#9a9a9a;margin:0 0 18px}.crumbs ol{list-style:none;margin:0;padding:0;display:flex;gap:6px}.crumbs li+li::before{content:'/';margin-right:6px}.crumbs a{color:#c9d1d8}
h1{margin:0;font-size:clamp(32px,5.4vw,48px);line-height:1.08;letter-spacing:-.03em;font-weight:600;color:#fff}
.lede{margin:16px 0 26px;font-size:18px;color:#c9d1d8;max-width:640px}
h2{margin:44px 0 12px;font-size:clamp(21px,3vw,26px);line-height:1.25;letter-spacing:-.02em;font-weight:600;color:#fff}
p,li{color:#c9d1d8}b{color:#f5f5f5}
ul,ol{padding-left:22px}li{margin:6px 0}
.cta{margin:40px 0 0;padding:24px;border:1px solid rgba(255,255,255,.2);border-radius:18px;background:rgba(255,255,255,.04);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}
.cta p{margin:0;color:#f5f5f5;font-weight:600;font-size:17px}.cta small{display:block;color:#9a9a9a;font-weight:400;font-size:14px}
.tw{overflow-x:auto;border:1px solid rgba(255,255,255,.2);border-radius:14px}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{padding:11px 14px;text-align:left;border-bottom:1px solid rgba(255,255,255,.09)}tr:last-child th,tr:last-child td{border-bottom:0}
thead th{color:#9a9a9a;font-size:14px}tbody th{color:#f5f5f5}td{color:#c9d1d8}td:nth-child(2){color:#fff;font-weight:600}
details{border:1px solid rgba(255,255,255,.2);border-radius:14px;background:rgba(255,255,255,.04);margin:8px 0}
summary{cursor:pointer;padding:14px 16px;font-weight:600;color:#f5f5f5}details p{margin:0;padding:0 16px 14px}
.more{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;list-style:none;padding:0}
.more li{margin:0}.more a{display:block;padding:12px 14px;border:1px solid rgba(255,255,255,.2);border-radius:12px;text-decoration:none;font-weight:600;font-size:15px;background:rgba(255,255,255,.04)}
footer{max-width:820px;margin:0 auto;padding:24px 20px 40px;border-top:1px solid rgba(255,255,255,.09);font-size:14px;color:#9a9a9a}footer p{margin:4px 0;color:#9a9a9a}footer a{color:#c9d1d8}`;

function block([kind, v]) {
  switch (kind) {
    case 'h2': return `<h2>${esc(v)}</h2>`;
    case 'p': return `<p>${v}</p>`;
    case 'ul': return `<ul>${v.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    case 'ol': return `<ol>${v.map((x) => `<li>${x}</li>`).join('')}</ol>`;
    case 'table': {
      const [head, ...rows] = v;
      return `<div class="tw"><table><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr><th scope="row">${esc(r[0])}</th>${r.slice(1).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    case 'faq': return `<h2>Questions</h2>${v.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${a}</p></details>`).join('')}`;
    case 'cta': return `<div class="cta"><p>Try it now, free<small>Opens in your browser. Nothing to install, nothing uploaded.</small></p><a class="btn" href="/">Open OMNICLIP</a></div>`;
    default: throw new Error(`build: unknown block ${kind}`);
  }
}

function renderPage(pg) {
  const url = `${SITE}/${pg.slug}/`;
  const faq = pg.body.find(([k]) => k === 'faq')?.[1] || [];
  const graph = [
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: pg.title, description: pg.description, inLanguage: 'en',
      isPartOf: { '@id': `${SITE}/#website` }, about: { '@id': `${SITE}/#app` }, dateModified: TODAY,
      breadcrumb: { '@id': `${url}#crumbs` } },
    { '@type': 'BreadcrumbList', '@id': `${url}#crumbs`, itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'OMNICLIP', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: pg.crumb, item: url }] },
    { '@type': 'WebSite', '@id': `${SITE}/#website`, name: 'OMNICLIP', url: `${SITE}/` },
  ];
  if (faq.length) graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: faq.map(([q, a]) => (
    { '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: strip(a) } })) });
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
  const others = PAGES.filter((p) => p.slug !== pg.slug && p.slug !== 'privacy');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pg.title)}</title>
<meta name="description" content="${esc(pg.description)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0a0a0a">
<meta name="color-scheme" content="dark">
<link rel="canonical" href="${url}">
<link rel="alternate" type="text/markdown" href="/${pg.slug}/index.md">
<meta property="og:type" content="article">
<meta property="og:site_name" content="OMNICLIP">
<meta property="og:title" content="${esc(pg.title)}">
<meta property="og:description" content="${esc(pg.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<style>${PAGE_CSS}</style>
<script type="application/ld+json">${ld}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header>
  <a class="brand" href="/" aria-label="OMNICLIP home">${LOGO}<span>MNICLIP</span></a>
  <a class="btn sm" href="/">Open the app</a>
</header>
<main id="main">
  <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="/">OMNICLIP</a></li><li aria-current="page">${esc(pg.crumb)}</li></ol></nav>
  <h1>${esc(pg.h1)}</h1>
  <p class="lede">${esc(pg.lede)}</p>
  ${pg.noCta ? '' : '<a class="btn" href="/">Open OMNICLIP, it’s free</a>'}
  ${pg.body.map(block).join('\n  ')}
  <h2>More guides</h2>
  <ul class="more">${others.map((p) => `<li><a href="/${p.slug}/">${esc(p.crumb)}</a></li>`).join('')}</ul>
</main>
<footer>
  <p>OMNICLIP: free shorts maker and video editor in your browser, by <a href="https://bankasimedia.com" rel="noopener">BANKASI MEDIA</a>.</p>
  <p><a href="/">Home</a> · <a href="/privacy/">Privacy</a> · <a href="https://github.com/marwenclock/omniclip" rel="noopener">Source code</a> · © 2026 BANKASI MEDIA</p>
</footer>
</body>
</html>
`;
}

for (const pg of PAGES) {
  mkdirSync(join(OUT, pg.slug), { recursive: true });
  writeFileSync(join(OUT, pg.slug, 'index.html'), renderPage(pg));
}

// ---------- Markdown copies for AI agents ----------
// /index.md and /<slug>/index.md. A Cloudflare URL-rewrite rule serves them to requests that send
// "Accept: text/markdown" (Markdown negotiation); pages also point to them with rel="alternate".
const md = (h) => String(h)
  .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, t) => `[${t}](${href.startsWith('/') ? SITE + href : href})`)
  .replace(/<\/?b>/g, '**').replace(/<sup>([^<]*)<\/sup>/g, ' $1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').trim();
function pageMd(pg) {
  const out = [`# ${pg.h1}`, '', pg.lede, ''];
  for (const [kind, v] of pg.body) {
    if (kind === 'h2') out.push(`## ${v}`, '');
    else if (kind === 'p') out.push(md(v), '');
    else if (kind === 'ul') out.push(...v.map((x) => `- ${md(x)}`), '');
    else if (kind === 'ol') out.push(...v.map((x, i) => `${i + 1}. ${md(x)}`), '');
    else if (kind === 'table') { const [h, ...r] = v; out.push(`| ${h.join(' | ')} |`, `| ${h.map(() => '---').join(' | ')} |`, ...r.map((x) => `| ${x.join(' | ')} |`), ''); }
    else if (kind === 'faq') { out.push('## Questions', ''); for (const [q, a] of v) out.push(`### ${q}`, '', md(a), ''); }
    else if (kind === 'cta') out.push(`[Open OMNICLIP, free, in your browser](${SITE}/)`, '');
  }
  out.push('---', '', `Source: ${SITE}/${pg.slug}/ · OMNICLIP by BANKASI MEDIA`, '');
  return out.join('\n');
}
for (const pg of PAGES) writeFileSync(join(OUT, pg.slug, 'index.md'), pageMd(pg));

// homepage: convert the crawlable .learn section of index.html (controlled markup, so simple rules suffice)
{
  const learn = index.slice(index.indexOf('<div class="learn">'), index.indexOf('<footer class="site-foot">'));
  if (learn.length < 500) throw new Error('build: .learn section not found in index.html');
  const lede = md(index.match(/<p class="lede">([\s\S]*?)<\/p>/)[1]);
  const body = learn
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, (_, t) => `\n## ${md(t)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, (_, t) => `\n### ${md(t)}\n\n`)
    .replace(/<summary>([\s\S]*?)<\/summary>/g, (_, t) => `\n### ${md(t)}\n\n`)
    .replace(/<tr>([\s\S]*?)<\/tr>/g, (_, r) => `| ${[...r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => md(c[1]) || ' ').join(' | ')} |\n`)
    .replace(/<\/thead>/g, '| --- | --- | --- |\n')
    .replace(/<ol class="steps">([\s\S]*?)<\/ol>/g, (_, l) => [...l.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m, i) => `${i + 1}. ${md(m[1])}`).join('\n') + '\n\n')
    .replace(/<li>([\s\S]*?)<\/li>/g, (_, t) => `- ${md(t)}\n`)
    .replace(/<p>([\s\S]*?)<\/p>/g, (_, t) => `${md(t)}\n\n`)
    .replace(/<[^>]+>/g, '')
    .split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    .replace(/^((?:\||- ).*)\n\n(?=\||- )/gm, '$1\n').replace(/^((?:\||- ).*)\n\n(?=\||- )/gm, '$1\n');
  writeFileSync(join(OUT, 'index.md'), `# OMNICLIP: long video in, shorts out\n\n${lede}\n\n[Open OMNICLIP](${SITE}/): free, in your browser, nothing uploaded\n\n${body}\n\n---\n\nSource: ${SITE}/ · OMNICLIP by BANKASI MEDIA · [Privacy](${SITE}/privacy/) · [Source code](https://github.com/marwenclock/omniclip)\n`);
}

// ---------- sitemap, robots, llms.txt ----------
const urls = [{ loc: `${SITE}/`, pri: '1.0' }, ...PAGES.map((p) => ({ loc: `${SITE}/${p.slug}/`, pri: p.slug === 'privacy' ? '0.3' : '0.8' }))];
writeFileSync(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${TODAY}</lastmod><priority>${u.pri}</priority></url>`).join('\n')}
</urlset>
`);

writeFileSync(join(OUT, 'robots.txt'), `# OMNICLIP: everything public may be crawled, indexed and quoted in search and AI answers.
User-agent: *
Content-Signal: search=yes, ai-input=yes
Allow: /

Sitemap: ${SITE}/sitemap.xml
`);

writeFileSync(join(OUT, 'llms.txt'), `# OMNICLIP

> OMNICLIP is a free, open-source AI shorts maker and video editor that runs entirely in the browser. It turns long videos and podcasts into vertical (9:16) shorts with captions. Videos are processed on the user's own computer: nothing is uploaded, there is no account and no watermark. Made by BANKASI MEDIA. MIT licence.

Key facts:
- Two ways in: "Create shorts" (transcribes and picks the best moments automatically) and "Edit a video" (opens the file to cut by hand).
- Transcription with Whisper models on the GPU (WebGPU); languages: English, Spanish, French, German, Portuguese, Italian, Arabic.
- An on-device LLM rates moments and writes titles; "Instant" mode needs no AI download.
- Speaker-following 9:16 reframing (face tracking), plus fixed, blurred-background and fit framing.
- Styled, word-timed captions burned into the video; SRT export; SRT/VTT import.
- Timeline editor: split, trim, reorder, cut pauses, speed, undo/redo; projects saved in the browser.
- Exports 1080p or 720p MP4 (WebM fallback), single clips or a zip. Audio-only files become audiograms.
- Requirements: a recent desktop Chrome or Edge with WebGPU. Exports run in real time with the tab visible.

## App
- [OMNICLIP](${SITE}/): the app and an overview with FAQ

## Guides
${PAGES.filter((p) => p.slug !== 'privacy').map((p) => `- [${p.h1}](${SITE}/${p.slug}/): ${p.description}`).join('\n')}

## Other
- [Privacy](${SITE}/privacy/): what stays on the device and which network requests the app makes
- [Source code](https://github.com/marwenclock/omniclip): GitHub repository (MIT)
`);

// ---------- headers (Cloudflare static assets _headers) ----------
// IndexNow (Bing, Yandex, Seznam, Naver...): the key file proves we own the site. Ping after a deploy with
// node tools/indexnow.mjs. The key is public by design.
const INDEXNOW_KEY = 'ecda49c7dc8ff8482a7ede9886c37f25';
writeFileSync(join(OUT, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);

// Link headers point agents at the Markdown copy, llms.txt and the sitemap (RFC 8288)
const pageHeaders = ['/', ...PAGES.map((p) => `/${p.slug}/`)].map((path) => `${path}
  Link: <${path}index.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"; type="text/plain", </sitemap.xml>; rel="sitemap"; type="application/xml"
  Vary: Accept
`).join('\n');
writeFileSync(join(OUT, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

${pageHeaders}
/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/og.png
  Cache-Control: public, max-age=604800

/icon-*
  Cache-Control: public, max-age=604800

/apple-touch-icon.png
  Cache-Control: public, max-age=604800

/favicon.svg
  Cache-Control: public, max-age=604800

/sample/*
  Cache-Control: public, max-age=604800
`);

// ---------- report ----------
const count = (d) => readdirSync(d).reduce((n, f) => n + (statSync(join(d, f)).isDirectory() ? count(join(d, f)) : 1), 0);
console.log(`build: dist/ ready (${count(OUT)} files, ${PAGES.length} guide pages, index.html ${(index.length / 1024).toFixed(0)} KB with inlined CSS)`);
if (!existsSync(join(OUT, 'app.js'))) throw new Error('build: app.js missing from dist');
