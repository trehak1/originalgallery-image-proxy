// Loads /works directly and through the proxy (cold and warm cache) in headless
// Chromium at 50 Mbit/s, scrolls through the whole page and records timings and
// transferred bytes. Usage: node measure.mjs
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import net from 'node:net';

const PAGE = 'https://originalgallery.com/works';
const PROXY_RULE = '--host-resolver-rules=MAP originalgallery.com:443 127.0.0.1:8443';
const COMPOSE = `docker compose -f ${new URL('../compose.yaml', import.meta.url).pathname}`;
const PROFILE = { down: 50e6 / 8, up: 10e6 / 8 };

// The proxy runs on localhost; once deployed it sits next to the origin, so its
// requests get the real client->origin round trip added as emulated latency.
async function originRtt() {
  const samples = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    await new Promise((ok, fail) => net.connect(443, 'originalgallery.com', function () { this.destroy(); ok(); }).on('error', fail));
    samples.push(performance.now() - t);
  }
  return Math.round(samples.sort((a, b) => a - b)[3]);
}

function purgeCache() {
  execSync(`${COMPOSE} exec -T proxy sh -c 'rm -rf /var/cache/nginx/img/*'`);
  execSync(`${COMPOSE} restart proxy`, { stdio: 'ignore' });
  execSync(`until curl -sk -o /dev/null https://127.0.0.1:8443/ -H 'Host: originalgallery.com'; do sleep 0.2; done`);
}

async function run(browser, profile, latency) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    new PerformanceObserver(l => { window.__lcp = l.getEntries().at(-1).startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency, downloadThroughput: profile.down, uploadThroughput: profile.up,
  });

  const reqs = new Map();
  let t0;
  cdp.on('Network.requestWillBeSent', e => {
    t0 ??= e.timestamp;
    reqs.set(e.requestId, { url: e.request.url, type: e.type });
  });
  cdp.on('Network.loadingFinished', e => {
    const r = reqs.get(e.requestId);
    if (r) Object.assign(r, { bytes: e.encodedDataLength, end: e.timestamp });
  });

  await page.goto(PAGE, { waitUntil: 'load', timeout: 300_000 });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, lcp: window.__lcp };
  });
  const bytesAtLoad = [...reqs.values()].reduce((s, r) => s + (r.bytes ?? 0), 0);

  // Scroll through the page so every lazy image loads, then wait for all of them.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 900) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 200));
    }
  });
  await page.waitForFunction(() => [...document.images].every(i => i.complete), null, { timeout: 300_000 });
  await page.waitForTimeout(500);

  const all = [...reqs.values()].filter(r => r.bytes !== undefined);
  const images = all.filter(r => r.type === 'Image' && new URL(r.url).hostname === 'originalgallery.com');
  const result = {
    ...Object.fromEntries(Object.entries(nav).map(([k, v]) => [k, Math.round(v)])),
    allImagesMs: Math.round((Math.max(...images.map(r => r.end)) - t0) * 1000),
    requests: all.length,
    totalBytes: all.reduce((s, r) => s + r.bytes, 0),
    bytesAtLoad,
    imageCount: images.length,
    imageBytes: images.reduce((s, r) => s + r.bytes, 0),
    largestImage: Math.max(...images.map(r => r.bytes)),
  };
  await context.close();
  return result;
}

const rtt = await originRtt();
console.log(`origin RTT ~${rtt} ms`);

const direct = await chromium.launch({ headless: true });
const proxied = await chromium.launch({ headless: true, args: [PROXY_RULE] });
const results = {};
results['bez proxy'] = await run(direct, PROFILE, 0);
purgeCache();
results['proxy, studená cache'] = await run(proxied, PROFILE, rtt);
results['proxy, teplá cache'] = await run(proxied, PROFILE, rtt);
await direct.close();
await proxied.close();

writeFileSync(new URL('results.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), rtt, results }, null, 2));
console.table(results);
