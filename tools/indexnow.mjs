// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver, Yep...) that every page in the sitemap
// changed, so they recrawl it soon. Run after a deploy: node tools/indexnow.mjs
// The key file /<key>.txt is written by tools/build.mjs.
const SITE = 'https://useomniclip.com';
const KEY = 'ecda49c7dc8ff8482a7ede9886c37f25';

const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: 'useomniclip.com', key: KEY, keyLocation: `${SITE}/${KEY}.txt`, urlList }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urlList.length} URLs`);
if (res.status >= 300) { console.log(await res.text()); process.exit(1); }
