#!/usr/bin/env node
// Status check of every crawled URL — the only thing the crawl is used for now.
// Usage: node health.js urls.json [--pages groups.json] [--concurrency 8]
//                       [--deadline 540] [--out health.json]
//
// Performance is measured only on the pages listed in the sheet, but a page
// that answers 500 is broken for every visitor no matter which list it is on,
// so the whole sitemap is requested once per run. --pages adds the sheet's
// URLs, in case some of them aren't in the sitemap.
//
// A 5xx is retried once after a few seconds; only a URL that fails both times
// is reported, so one slow PHP worker doesn't raise an alarm. 404/410 are
// listed separately (a sitemap advertising dead pages is its own problem),
// and 403/429 are counted as "blocked": that is usually bot protection
// against this machine's IP, not a broken page.

const fs = require("fs");

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--pages", "--concurrency", "--deadline", "--out"];
const input = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const PAGES = getFlag("pages", null);
const CONCURRENCY = Math.max(1, parseInt(getFlag("concurrency", "8"), 10));
const DEADLINE_S = Math.max(30, parseInt(getFlag("deadline", "540"), 10));
const OUT = getFlag("out", null);
const LIST_MAX = 50;   // per category, to keep the run document small

if (!input) {
  console.error("usage: node health.js urls.json [--pages groups.json] [--concurrency 8] [--deadline 540] [--out health.json]");
  process.exit(1);
}

const crawl = JSON.parse(fs.readFileSync(input, "utf8"));
const urls = new Set(crawl.urls || []);
const sheetUrls = new Set();
if (PAGES) {
  for (const g of JSON.parse(fs.readFileSync(PAGES, "utf8")).groups || []) {
    if (g.sample) { urls.add(g.sample); sheetUrls.add(g.sample); }
  }
}

const START = Date.now();
const left = () => DEADLINE_S * 1000 - (Date.now() - START);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(1000, Math.min(30000, left()))),
      headers: { "user-agent": "Mozilla/5.0 (compatible; site-perf-report health check)" }
    });
    try { await res.body?.cancel(); } catch {}
    return { status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { status: null, error: e.name === "TimeoutError" ? "timeout" : (e.cause && e.cause.code) || e.message, ms: Date.now() - t0 };
  }
}

async function check(url) {
  let r = await get(url);
  if ((r.status === null || r.status >= 500) && left() > 40000) {
    await sleep(4000);
    const again = await get(url);
    r = Object.assign(again, { retried: true, firstStatus: r.status });
  }
  return Object.assign({ url }, r);
}

(async () => {
  const queue = [...urls];
  const results = [];
  let notChecked = 0;
  async function worker() {
    while (queue.length) {
      if (left() < 35000) { notChecked += queue.length; queue.length = 0; return; }
      results.push(await check(queue.shift()));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const pick = f => results.filter(f).map(r => {
    const o = { url: r.url, status: r.status === null ? r.error : r.status };
    if (sheetUrls.has(r.url)) o.tracked = true;
    return o;
  });
  const serverErrors = pick(r => r.status !== null && r.status >= 500);
  const notFound = pick(r => r.status === 404 || r.status === 410);
  const networkErrors = pick(r => r.status === null);
  const blocked = results.filter(r => r.status === 403 || r.status === 429).length;

  const health = {
    checkedAt: new Date(START).toISOString(),
    source: crawl.source || null,
    checked: results.length,
    notChecked,
    ok: results.filter(r => r.status >= 200 && r.status < 400).length,
    serverErrors: serverErrors.slice(0, LIST_MAX),
    serverErrorCount: serverErrors.length,
    notFound: notFound.slice(0, LIST_MAX),
    notFoundCount: notFound.length,
    networkErrors: networkErrors.slice(0, LIST_MAX),
    networkErrorCount: networkErrors.length,
    blockedCount: blocked,
    failedSitemaps: crawl.failedSitemaps || []
  };

  const json = JSON.stringify(health, null, 2);
  if (OUT) fs.writeFileSync(OUT, json); else console.log(json);

  const secs = Math.round((Date.now() - START) / 1000);
  console.error(`health: ${results.length} URLs checked in ${secs}s — ${serverErrors.length} server error(s), ` +
    `${notFound.length} not found, ${networkErrors.length} network error(s), ${blocked} blocked` +
    (notChecked ? `, ${notChecked} NOT CHECKED (deadline)` : "") + (OUT ? ` -> ${OUT}` : ""));
  if (serverErrors.length) {
    console.error("health: SERVER ERRORS (5xx on two attempts):");
    for (const e of serverErrors.slice(0, 20)) console.error(`  ${e.status} ${e.url}${e.tracked ? " (tracked page)" : ""}`);
  }
  for (const f of health.failedSitemaps) console.error(`health: SITEMAP FETCH FAILED ${f.url} (${f.status})`);
})().catch(e => { console.error("health: " + e.message); process.exit(1); });
