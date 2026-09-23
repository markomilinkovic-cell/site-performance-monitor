#!/usr/bin/env node
// Crawl a site and emit a plain list of URLs as JSON.
// Usage: node crawl.js https://example.com [--max 2000] [--out urls.json]

const https = require("https");
const http = require("http");
const { URL } = require("url");

const args = process.argv.slice(2);
const start = args.find(a => !a.startsWith("--"));
const getFlag = (name, def) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? def : args[i + 1];
};
const MAX = parseInt(getFlag("max", "2000"), 10);
const OUT = getFlag("out", null);

if (!start) {
  console.error("usage: node crawl.js https://example.com [--max N] [--out file.json]");
  process.exit(1);
}

const origin = new URL(start).origin;
const host = new URL(start).host;

function fetch(url, redirects = 0) {
  return new Promise(resolve => {
    if (redirects > 5) return resolve(null);
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "user-agent": "site-perf-report/1.0" }, timeout: 20000 },
      res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return resolve(fetch(next, redirects + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", c => { body += c; if (body.length > 12e6) req.destroy(); });
        res.on("end", () => resolve(body));
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function tags(xml, tag) {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

function clean(raw) {
  try {
    const u = new URL(raw.replace(/&amp;/g, "&").trim());
    if (u.host !== host) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    if (/\.(jpg|jpeg|png|gif|svg|webp|avif|css|js|pdf|zip|mp4|webm|woff2?|ico|xml|json|txt)$/i.test(u.pathname)) return null;
    u.hash = "";
    u.search = "";
    let p = u.pathname.replace(/\/+$/, "");
    u.pathname = p === "" ? "/" : p;
    return u.href;
  } catch { return null; }
}

async function fromSitemaps() {
  const seen = new Set();
  const queue = [origin + "/sitemap.xml", origin + "/sitemap_index.xml", origin + "/wp-sitemap.xml"];
  const robots = await fetch(origin + "/robots.txt");
  if (robots) {
    for (const line of robots.split("\n")) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) queue.push(m[1].trim());
    }
  }
  const urls = new Set();
  const visited = new Set();
  while (queue.length && urls.size < MAX) {
    const sm = queue.shift();
    if (visited.has(sm)) continue;
    visited.add(sm);
    const xml = await fetch(sm);
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const isIndex = /<sitemapindex/i.test(xml);
    for (const block of tags(xml, isIndex ? "sitemap" : "url")) {
      const loc = tags(block, "loc")[0];
      if (!loc) continue;
      if (isIndex) { queue.push(loc.replace(/&amp;/g, "&").trim()); continue; }
      const c = clean(loc);
      if (c && !seen.has(c)) { seen.add(c); urls.add(c); }
      if (urls.size >= MAX) break;
    }
  }
  return [...urls];
}

async function fromLinks() {
  const seen = new Set([clean(start) || start]);
  const queue = [clean(start) || start];
  const out = [];
  while (queue.length && out.length < Math.min(MAX, 300)) {
    const url = queue.shift();
    const html = await fetch(url);
    if (!html) continue;
    out.push(url);
    const re = /href\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      let abs;
      try { abs = new URL(m[1], url).href; } catch { continue; }
      const c = clean(abs);
      if (c && !seen.has(c)) { seen.add(c); queue.push(c); }
    }
  }
  return out;
}

(async () => {
  let urls = await fromSitemaps();
  let source = "sitemap";
  if (urls.length < 2) {
    urls = await fromLinks();
    source = "links";
  }
  urls.sort();
  const result = { site: host, origin, source, count: urls.length, urls };
  const json = JSON.stringify(result, null, 2);
  if (OUT) {
    require("fs").writeFileSync(OUT, json);
    console.error(`crawl: ${urls.length} urls via ${source} -> ${OUT}`);
  } else {
    console.log(json);
  }
})();
