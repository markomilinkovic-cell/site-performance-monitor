#!/usr/bin/env node
// Run Lighthouse over the sampled URLs from group.js and emit dashboard JSON.
// Usage: node audit.js groups.json [--strategy both|mobile|desktop] [--out run.json]
//
// Default is both: Google ranks mobile and desktop separately, and the two
// scores routinely differ by 20+ points on the same page, so one number alone
// is misleading.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith("--"));
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const STRATEGY = getFlag("strategy", "both");
const RUNS = Math.max(1, parseInt(getFlag("runs", "3"), 10));
const OUT = getFlag("out", null);

if (!input) {
  console.error("usage: node audit.js groups.json [--strategy both|mobile|desktop] [--out run.json]");
  process.exit(1);
}
const STRATEGIES = STRATEGY === "both" ? ["mobile", "desktop"] : [STRATEGY];

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [
    path.join(os.homedir(), ".cache/puppeteer/chrome"),
    process.env.HOME ? path.join(process.env.HOME, ".cache/puppeteer/chrome") : null,
    "/home/claude/.cache/puppeteer/chrome",
    "/root/.cache/puppeteer/chrome"
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const p = path.join(root, dir, "chrome-linux64", "chrome");
      if (fs.existsSync(p)) return p;
    }
  }
  for (const bin of ["google-chrome", "chromium", "chromium-browser"]) {
    try { return execSync(`which ${bin}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
  }
  return null;
}

const chrome = findChrome();
if (!chrome) {
  console.error("Chrome not found. Install with: npx puppeteer browsers install chrome");
  process.exit(1);
}
process.env.CHROME_PATH = chrome;

const METRIC_KEYS = {
  fcp: "first-contentful-paint",
  lcp: "largest-contentful-paint",
  tbt: "total-blocking-time",
  cls: "cumulative-layout-shift",
  si: "speed-index",
  tti: "interactive"
};

function runLighthouse(url, strategy) {
  const tmp = path.join(os.tmpdir(), `lh-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const flags = [url, "--only-categories=performance", "--output=json", `--output-path=${tmp}`,
    '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu', "--quiet"];
  if (strategy === "desktop") flags.push("--preset=desktop");
  else flags.push("--form-factor=mobile", "--screenEmulation.mobile");

  execFileSync("lighthouse", flags, { stdio: ["ignore", "ignore", "pipe"], timeout: 180000 });
  const report = JSON.parse(fs.readFileSync(tmp, "utf8"));
  fs.unlinkSync(tmp);

  const finalUrl = report.finalDisplayedUrl || url;
  const want = new URL(url).pathname.replace(/\/+$/, "");
  const got = new URL(finalUrl).pathname.replace(/\/+$/, "");
  if (want !== got) {
    const err = new Error(`redirected to ${got || "/"} — not the requested page`);
    err.redirect = true;
    throw err;
  }

  const a = report.audits;
  const metrics = {};
  for (const [key, id] of Object.entries(METRIC_KEYS)) {
    if (!a[id] || typeof a[id].numericValue !== "number") continue;
    const v = a[id].numericValue;
    metrics[key] = key === "cls" ? Math.round(v * 10000) / 10000
      : key === "tbt" ? Math.round(v)
      : Math.round(v / 100) / 10;
  }

  const opportunities = Object.values(a)
    .filter(x => x.details && x.details.type === "opportunity" && x.details.overallSavingsMs > 50)
    .sort((x, y) => y.details.overallSavingsMs - x.details.overallSavingsMs)
    .slice(0, 5)
    .map(x => ({ title: x.title, savingsMs: Math.round(x.details.overallSavingsMs) }));

  return {
    score: Math.round((report.categories.performance.score || 0) * 100),
    metrics,
    opportunities,
    benchmarkIndex: report.environment && report.environment.benchmarkIndex
      ? Math.round(report.environment.benchmarkIndex) : null
  };
}

// Lighthouse is a lab measurement on a shared machine: the same page scores
// several points apart between consecutive runs, mostly through TBT, because
// CPU availability fluctuates. Take the median of N runs and carry the spread
// so a reader can tell a real regression from noise.
function measure(url, strategy, runs) {
  const results = [];
  let lastErr = null;
  for (let i = 0; i < runs; i++) {
    try {
      results.push(runLighthouse(url, strategy));
    } catch (e) {
      lastErr = e;
      process.stderr.write(`    run ${i + 1}/${runs} failed: ${reason(e)}\n`);
      if (e.redirect) throw e;   // no point retrying a redirect
    }
  }
  if (!results.length) throw lastErr || new Error("no successful run");
  if (results.length < runs) {
    process.stderr.write(`    only ${results.length}/${runs} runs succeeded — spread below is less reliable\n`);
  }

  const sorted = [...results].sort((a, b) => a.score - b.score);
  const median = sorted[Math.floor(sorted.length / 2)];
  const scores = sorted.map(r => r.score);
  return Object.assign({}, median, {
    runs: results.length,
    spread: scores.length > 1 ? { min: scores[0], max: scores[scores.length - 1] } : null,
    allScores: scores
  });
}

function reason(e) {
  const err = (e && e.stderr ? e.stderr.toString() : "") || String(e && e.message || e);
  const line = err.split("\n").map(s => s.trim()).find(s => /error|failed|ERR_|redirect|status code/i.test(s));
  return (line || err.split("\n")[0] || "unknown").slice(0, 160);
}

const src = JSON.parse(fs.readFileSync(input, "utf8"));
const groups = [];
const skipped = [];

for (const g of src.groups) {
  const tries = [g.sample, ...(g.candidates || [])];
  let page = null, lastErr = null;

  // Resolve a working URL on the first strategy, then reuse it for the rest so
  // both form factors describe the same page.
  for (const url of tries) {
    const result = {};
    let ok = true;
    for (const s of STRATEGIES) {
      process.stderr.write(`audit: ${g.name} [${s}] -> ${url} ... `);
      try {
        result[s] = measure(url, s, RUNS);
        const sp = result[s].spread;
        process.stderr.write(`${result[s].score}${sp && sp.min !== sp.max ? ` (${sp.min}–${sp.max})` : ""}\n`);
      } catch (e) {
        lastErr = e;
        ok = false;
        process.stderr.write(`failed (${reason(e)})\n`);
        break;
      }
    }
    if (ok) { page = Object.assign({ url, title: g.name }, result); break; }
  }

  if (!page) {
    skipped.push({ name: g.name, reason: reason(lastErr) });
    process.stderr.write(`audit: ${g.name} SKIPPED — no measurable URL\n`);
    continue;
  }
  const out = { name: g.name, pattern: g.pattern, totalPages: g.totalPages, pages: [page] };
  if (g.provisional) out.provisional = true;
  if (g.notInSitemap) out.notInSitemap = true;
  groups.push(out);
}

const run = {
  site: src.site,
  origin: src.origin || ("https://" + src.site),
  strategies: STRATEGIES,
  runsPerPage: RUNS,
  generated: new Date().toISOString().slice(0, 10),
  generatedAt: new Date().toISOString(),
  groups,
  skipped,
  // Carried from apply-config.js so an unattended run leaves a visible trace
  // when the site's structure no longer matches the saved config.
  drift: src.drift || null,
  configApplied: !!src.configApplied
};

const json = JSON.stringify(run, null, 2);
if (OUT) {
  fs.writeFileSync(OUT, json);
  console.error(`audit: ${groups.length} groups measured (median of ${RUNS}), ${skipped.length} skipped -> ${OUT}`);
} else {
  console.log(json);
}
