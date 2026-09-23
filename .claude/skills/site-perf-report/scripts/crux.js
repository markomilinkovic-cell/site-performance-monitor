#!/usr/bin/env node
// Fetch CrUX field data (what real Chrome users actually experienced) and
// attach it to a run document.
//
// Usage: CRUX_API_KEY=... node crux.js run.json [--out run.json]
//
// Lighthouse is a lab measurement on one machine. CrUX is the 28-day rolling
// aggregate of real visits from Chrome users who opted in. They answer
// different questions: Lighthouse says "why is this slow", CrUX says "is it
// slow for the people using it". Use both.
//
// An API key is required (free): https://developer.chrome.com/docs/crux/api
// Enable "Chrome UX Report API" in a Google Cloud project and create a key.
//
// NOTE: the response shape below follows Google's documented schema but has
// not been observed against a live key in this environment. If parsing fails,
// the script writes the raw response to <out>.raw.json and says so, rather
// than silently producing wrong numbers.

const fs = require("fs");
const https = require("https");

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith("--"));
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const OUT = getFlag("out", input);
const KEY = process.env.CRUX_API_KEY;

if (!input) {
  console.error("usage: CRUX_API_KEY=... node crux.js run.json [--out run.json]");
  process.exit(1);
}
if (!KEY) {
  console.error("CRUX_API_KEY is not set. Get a free key: https://developer.chrome.com/docs/crux/api");
  process.exit(2);
}

function query(body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        host: "chromeuxreport.googleapis.com",
        path: "/v1/records:queryRecord?key=" + encodeURIComponent(KEY),
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: 30000
      },
      res => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", c => (b += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(b), raw: b }); }
          catch { resolve({ status: res.statusCode, json: null, raw: b }); }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", e => resolve({ status: 0, json: null, raw: String(e.message || e) }));
    req.write(payload);
    req.end();
  });
}

// Metrics worth reporting, with the unit the dashboard expects.
const WANTED = {
  largest_contentful_paint: { key: "lcp", unit: "s" },
  interaction_to_next_paint: { key: "inp", unit: "ms" },
  cumulative_layout_shift: { key: "cls", unit: "" },
  first_contentful_paint: { key: "fcp", unit: "s" },
  experimental_time_to_first_byte: { key: "ttfb", unit: "s" }
};

function parseMetrics(metrics) {
  const out = {};
  if (!metrics || typeof metrics !== "object") return out;
  for (const [name, spec] of Object.entries(WANTED)) {
    const m = metrics[name];
    if (!m) continue;
    const p75 = m.percentiles && m.percentiles.p75;
    if (p75 === undefined) continue;
    const num = typeof p75 === "string" ? parseFloat(p75) : p75;
    if (!isFinite(num)) continue;
    out[spec.key] = {
      p75: spec.unit === "s" ? Math.round(num / 100) / 10 : spec.unit === "ms" ? Math.round(num) : num,
      unit: spec.unit,
      // histogram is three bins: good / needs improvement / poor
      distribution: Array.isArray(m.histogram)
        ? m.histogram.map(h => Math.round((h.density || 0) * 1000) / 10)
        : null
    };
  }
  return out;
}

(async () => {
  const run = JSON.parse(fs.readFileSync(input, "utf8"));
  const origin = run.origin || ("https://" + run.site);
  const forms = [["PHONE", "mobile"], ["DESKTOP", "desktop"]];
  const field = {};
  let parseFailed = null;

  for (const [formFactor, label] of forms) {
    const res = await query({ origin, formFactor });
    if (res.status === 404) {
      field[label] = { unavailable: "nema dovoljno podataka za ovaj origin" };
      process.stderr.write(`crux: ${label} — no data for ${origin}\n`);
      continue;
    }
    if (res.status !== 200 || !res.json) {
      field[label] = { unavailable: `HTTP ${res.status}` };
      process.stderr.write(`crux: ${label} — HTTP ${res.status}\n`);
      parseFailed = parseFailed || res.raw;
      continue;
    }
    const record = res.json.record;
    const metrics = parseMetrics(record && record.metrics);
    if (!Object.keys(metrics).length) {
      parseFailed = res.raw;
      field[label] = { unavailable: "neprepoznat oblik odgovora" };
      process.stderr.write(`crux: ${label} — response parsed to zero metrics\n`);
      continue;
    }
    field[label] = {
      metrics,
      collectionPeriod: record.collectionPeriod || null
    };
    process.stderr.write(`crux: ${label} — ${Object.keys(metrics).join(", ")}\n`);
  }

  run.crux = { origin, fetchedAt: new Date().toISOString(), field };
  fs.writeFileSync(OUT, JSON.stringify(run, null, 2));

  if (parseFailed) {
    const rawPath = OUT + ".raw.json";
    fs.writeFileSync(rawPath, parseFailed);
    console.error(`crux: unexpected response saved to ${rawPath} — check it before trusting the output`);
  }
  console.error(`crux: attached to ${OUT}`);
})();
