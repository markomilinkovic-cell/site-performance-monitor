#!/usr/bin/env node
// Measure the sampled URLs from group.js with the PageSpeed Insights API and
// emit dashboard JSON.
//
// Usage: PSI_API_KEY=... node audit.js groups.json
//          [--strategy both|mobile|desktop] [--runs 3] [--concurrency 10]
//          [--deadline 270] [--out run.json]
//
// PSI runs Lighthouse on Google's own machines, so nothing is installed here
// and the local CPU no longer feeds into the score. Each call takes 20-90s,
// but calls run in parallel, so a whole group (both form factors, three runs)
// costs roughly one call's worth of wall time.
//
// Default is both strategies: Google ranks mobile and desktop separately, and
// the two scores routinely differ by 20+ points on the same page.
//
// The response also carries CrUX field data for the origin (real Chrome
// users, 28-day rolling), which is attached as run.crux in the same shape
// crux.js produces, so the dashboard shows it without a separate key.

const fs = require("fs");

const args = process.argv.slice(2);
const VALUE_FLAGS = ["--strategy", "--runs", "--concurrency", "--deadline", "--out"];
const input = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const STRATEGY = getFlag("strategy", "both");
const RUNS = Math.max(1, parseInt(getFlag("runs", "3"), 10));
const CONCURRENCY = Math.max(1, parseInt(getFlag("concurrency", "10"), 10));
// Stop starting new calls after this many seconds and write what we have.
// 270 fits the 300s command limit in claude.ai chat; lower it for shorter limits.
const DEADLINE_S = Math.max(30, parseInt(getFlag("deadline", "270"), 10));
const OUT = getFlag("out", null);
const KEY = process.env.PSI_API_KEY || "";
// In a Claude Code cloud environment the key can be stored as an API credential
// that the agent proxy attaches to requests for www.googleapis.com (header
// X-Goog-Api-Key), so the session never sees it. Set PSI_KEY_FROM_PROXY=1 there.
const KEY_FROM_PROXY = /^(1|true|yes)$/i.test(process.env.PSI_KEY_FROM_PROXY || "");

if (!input) {
  console.error("usage: PSI_API_KEY=... node audit.js groups.json [--strategy both|mobile|desktop] " +
    "[--runs 3] [--concurrency 10] [--deadline 270] [--out run.json]");
  process.exit(1);
}
if (!KEY && !KEY_FROM_PROXY) {
  console.error("PSI_API_KEY is not set (and PSI_KEY_FROM_PROXY isn't either). Without a key PSI shares " +
    "one exhausted public quota and answers 429. Create a key: " +
    "https://developers.google.com/speed/docs/insights/v5/get-started");
  process.exit(2);
}
if (!["both", "mobile", "desktop"].includes(STRATEGY)) {
  console.error(`unknown --strategy ${STRATEGY}`);
  process.exit(1);
}
const STRATEGIES = STRATEGY === "both" ? ["mobile", "desktop"] : [STRATEGY];
const START = Date.now();
const remainingMs = () => DEADLINE_S * 1000 - (Date.now() - START);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- limiter

let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= CONCURRENCY) await new Promise(r => waiting.push(r));
  active++;
  try { return await fn(); }
  finally { active--; const next = waiting.shift(); if (next) next(); }
}

// ------------------------------------------------------------------ errors

class AuditError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}
// kind: redirect | dead | quota | budget | transient
let quotaExhausted = null;

// Never let the key reach a log line or the run document.
const redact = s => KEY ? String(s || "").split(KEY).join("***") : String(s || "");

// ------------------------------------------------------------- preflight

// PSI reports a 404 page as a generic HTTP 500 ("Something went wrong"),
// indistinguishable from a transient failure. A plain GET from here tells the
// two apart in under a second, before spending a 60s PSI call on a dead URL.
async function preflight(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; site-perf-report preflight)" }
    });
    try { await res.body?.cancel(); } catch {}
    const want = new URL(url).pathname.replace(/\/+$/, "");
    const got = new URL(res.url || url).pathname.replace(/\/+$/, "");
    if (want !== got) return { ok: false, definite: true, reason: `redirected to ${got || "/"} — not the requested page` };
    if (res.status === 404 || res.status === 410) return { ok: false, definite: true, reason: `HTTP ${res.status}` };
    if (res.status >= 200 && res.status < 300) return { ok: true };
    // 403/429/5xx from here may be bot protection against this machine's IP;
    // PSI comes from Google and may still get through, so don't rule it out.
    return { ok: false, definite: false, reason: `HTTP ${res.status} from preflight` };
  } catch (e) {
    return { ok: false, definite: false, reason: `preflight failed: ${e.name === "TimeoutError" ? "timeout" : e.message}` };
  }
}

// ---------------------------------------------------------------- PSI call

async function psiOnce(url, strategy) {
  const budget = remainingMs();
  if (budget < 20000) throw new AuditError("time budget used up — rerun this group", "budget");
  // The key travels in a header rather than the query string, so it never
  // appears in a URL, a proxy log or an error message that echoes the URL.
  const q = new URLSearchParams({ url, strategy, category: "performance" });
  let res, body;
  try {
    res = await fetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + q, {
      headers: KEY ? { "X-Goog-Api-Key": KEY } : {},
      signal: AbortSignal.timeout(Math.min(180000, budget))
    });
    body = await res.text();
  } catch (e) {
    throw new AuditError(e.name === "TimeoutError" ? "PSI call timed out" : redact(e.message), "transient");
  }
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (res.status !== 200 || !json || !json.lighthouseResult) {
    const msg = redact((json && json.error && json.error.message) || body.slice(0, 200));
    if (res.status === 429 && /per day/i.test(msg)) {
      // A keyless call lands on Google's shared public quota, which is always
      // used up, so in proxy mode this usually means the key wasn't attached.
      throw new AuditError(KEY_FROM_PROXY
        ? "PSI daily quota exhausted — most likely the proxy didn't attach the key; check the environment's API credential (host www.googleapis.com, header X-Goog-Api-Key)"
        : "PSI daily quota exhausted", "quota");
    }
    if (res.status === 400 && /api key|API_KEY/i.test(msg)) throw new AuditError(`PSI rejected the API key: ${msg}`, "quota");
    if (res.status === 403) throw new AuditError(`PSI refused (403): ${msg} — is the PageSpeed Insights API enabled for this key?`, "quota");
    if (/ERRORED_DOCUMENT_REQUEST|FAILED_DOCUMENT_REQUEST|DNS_FAILURE|NOT_HTML/.test(msg)) throw new AuditError(msg, "dead");
    throw new AuditError(`PSI HTTP ${res.status}: ${msg}`, "transient");
  }
  return json;
}

async function psi(url, strategy) {
  // Transient PSI failures (500 "Something went wrong", 429 per-minute, timeouts)
  // usually clear on a retry; the rest never do.
  const waits = [5000, 20000];
  for (let attempt = 0; ; attempt++) {
    if (quotaExhausted) throw new AuditError(quotaExhausted, "quota");
    try {
      return await limited(() => psiOnce(url, strategy));
    } catch (e) {
      if (e.kind === "quota") quotaExhausted = quotaExhausted || e.message;
      if (e.kind !== "transient" || attempt >= waits.length || remainingMs() < waits[attempt] + 30000) throw e;
      await sleep(waits[attempt]);
    }
  }
}

// ------------------------------------------------------------ parse result

const METRIC_KEYS = {
  fcp: "first-contentful-paint",
  lcp: "largest-contentful-paint",
  tbt: "total-blocking-time",
  cls: "cumulative-layout-shift",
  si: "speed-index",
  tti: "interactive"
};

// CrUX metrics as PSI names them -> dashboard key and unit.
const FIELD_KEYS = {
  LARGEST_CONTENTFUL_PAINT_MS: { key: "lcp", unit: "s" },
  INTERACTION_TO_NEXT_PAINT: { key: "inp", unit: "ms" },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { key: "cls", unit: "" },
  FIRST_CONTENTFUL_PAINT_MS: { key: "fcp", unit: "s" },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: { key: "ttfb", unit: "s" }
};

function parseField(exp) {
  if (!exp || !exp.metrics) return null;
  const out = {};
  for (const [name, spec] of Object.entries(FIELD_KEYS)) {
    const m = exp.metrics[name];
    if (!m || typeof m.percentile !== "number") continue;
    const p = m.percentile;
    out[spec.key] = {
      // PSI reports CLS multiplied by 100 (percentile 5 means 0.05).
      p75: spec.unit === "s" ? Math.round(p / 100) / 10 : spec.unit === "ms" ? Math.round(p) : Math.round(p) / 100,
      unit: spec.unit,
      distribution: Array.isArray(m.distributions) && m.distributions.length === 3
        ? m.distributions.map(d => Math.round((d.proportion || 0) * 1000) / 10)
        : null,
      category: m.category || null
    };
  }
  return Object.keys(out).length ? out : null;
}

function parse(json, url) {
  const L = json.lighthouseResult;
  if (L.runtimeError && L.runtimeError.code && L.runtimeError.code !== "NO_ERROR") {
    throw new AuditError(`Lighthouse: ${L.runtimeError.code} ${L.runtimeError.message || ""}`.trim(), "dead");
  }

  const finalUrl = L.finalDisplayedUrl || L.finalUrl || url;
  const want = new URL(url).pathname.replace(/\/+$/, "");
  const got = new URL(finalUrl).pathname.replace(/\/+$/, "");
  if (want !== got) throw new AuditError(`redirected to ${got || "/"} — not the requested page`, "redirect");

  const a = L.audits || {};
  const metrics = {};
  for (const [key, id] of Object.entries(METRIC_KEYS)) {
    if (!a[id] || typeof a[id].numericValue !== "number") continue;
    const v = a[id].numericValue;
    metrics[key] = key === "cls" ? Math.round(v * 10000) / 10000
      : key === "tbt" ? Math.round(v)
      : Math.round(v / 100) / 10;
  }

  // Lighthouse 12+ reports savings as metricSavings (LCP/FCP in ms) on both
  // the legacy "opportunity" audits and the newer insight audits. Only failing
  // audits count; a passing audit with nominal savings isn't worth listing.
  const seen = new Set();
  const opportunities = Object.values(a)
    .filter(x => typeof x.score === "number" && x.score < 0.9)
    .map(x => {
      const ms = x.metricSavings || {};
      const savings = Math.max(ms.LCP || 0, ms.FCP || 0,
        x.details && typeof x.details.overallSavingsMs === "number" ? x.details.overallSavingsMs : 0);
      return { title: x.title, savingsMs: Math.round(savings) };
    })
    .filter(o => o.savingsMs > 50 && !seen.has(o.title) && seen.add(o.title))
    .sort((x, y) => y.savingsMs - x.savingsMs)
    .slice(0, 5);

  const le = json.loadingExperience;
  return {
    score: Math.round(((L.categories && L.categories.performance && L.categories.performance.score) || 0) * 100),
    metrics,
    opportunities,
    benchmarkIndex: L.environment && L.environment.benchmarkIndex ? Math.round(L.environment.benchmarkIndex) : null,
    lighthouseVersion: L.lighthouseVersion || null,
    // URL-level CrUX only when Google has enough data for this exact page;
    // otherwise PSI repeats the origin numbers, which already go to run.crux.
    field: le && !le.origin_fallback ? parseField(le) : null,
    originField: parseField(json.originLoadingExperience)
  };
}

// ---------------------------------------------------------------- measure

function reason(e) {
  return redact((e && e.message) || e || "unknown").split("\n")[0].slice(0, 200);
}

// Lab scores still vary between runs, even on Google's hardware (network,
// server response). Take the median of N runs and carry the spread so a reader
// can tell a real regression from noise.
function summarise(results, runs, label) {
  const sorted = [...results].sort((x, y) => x.score - y.score);
  const median = sorted[Math.floor(sorted.length / 2)];
  const scores = sorted.map(r => r.score);
  if (results.length < runs) {
    process.stderr.write(`    ${label}: only ${results.length}/${runs} runs succeeded — spread below is less reliable\n`);
  }
  const { originField, ...rest } = median;
  if (!rest.field) delete rest.field;
  return Object.assign(rest, {
    runs: results.length,
    spread: scores.length > 1 ? { min: scores[0], max: scores[scores.length - 1] } : null,
    allScores: scores
  });
}

const originField = {};   // strategy -> parsed origin CrUX, from any successful call

async function measureUrl(g, url) {
  // Launch every strategy x run for this URL at once; the limiter spaces them.
  const jobs = [];
  for (const s of STRATEGIES) {
    for (let i = 0; i < RUNS; i++) {
      jobs.push(psi(url, s).then(j => parse(j, url)).then(
        r => ({ s, i, r }),
        e => ({ s, i, e })
      ));
    }
  }
  const done = await Promise.all(jobs);

  const result = {};
  const failures = {};
  for (const s of STRATEGIES) {
    const mine = done.filter(d => d.s === s);
    const ok = mine.filter(d => d.r).map(d => d.r);
    const bad = mine.filter(d => d.e);
    for (const b of bad) process.stderr.write(`    ${g.name} [${s}] run ${b.i + 1}/${RUNS} failed: ${reason(b.e)}\n`);
    if (ok.length) {
      if (!originField[s]) originField[s] = ok.find(r => r.originField)?.originField || null;
      result[s] = summarise(ok, RUNS, `${g.name} [${s}]`);
    } else {
      failures[s] = bad[0] && bad[0].e;
    }
  }
  return { result, failures };
}

async function measureGroup(g) {
  const tries = [g.sample, ...(g.candidates || [])].filter(Boolean);
  const checks = await Promise.all(tries.map(preflight));
  // Definitely dead URLs go last rather than disappearing, in case the site
  // only misbehaves for this machine.
  const order = tries.map((u, i) => ({ u, c: checks[i] }))
    .sort((x, y) => (x.c.ok ? 0 : x.c.definite ? 2 : 1) - (y.c.ok ? 0 : y.c.definite ? 2 : 1));

  if (!checks[0].ok && order[0].u !== tries[0]) {
    process.stderr.write(`audit: ${g.name} sample ${tries[0]} failed preflight (${checks[0].reason}), trying candidates first\n`);
  }
  let lastErr = null;
  for (const { u, c } of order) {
    if (!c.ok && c.definite) {
      process.stderr.write(`audit: ${g.name} -> ${u} skipped by preflight (${c.reason})\n`);
      lastErr = lastErr || new AuditError(c.reason, "dead");
      continue;
    }
    process.stderr.write(`audit: ${g.name} -> ${u} (${STRATEGIES.join(" + ")}, ${RUNS} run${RUNS > 1 ? "s" : ""} each)\n`);
    const { result, failures } = await measureUrl(g, u);
    const got = Object.keys(result);
    if (got.length === STRATEGIES.length) {
      process.stderr.write(`audit: ${g.name} ` + got.map(s => {
        const sp = result[s].spread;
        return `${s} ${result[s].score}${sp && sp.min !== sp.max ? ` (${sp.min}–${sp.max})` : ""}`;
      }).join(", ") + "\n");
      return { ok: true, page: Object.assign({ url: u, title: g.name }, result) };
    }
    const errs = Object.values(failures).filter(Boolean);
    lastErr = errs[0] || lastErr;
    // A partial result on this URL (one form factor measured, the other ran out
    // of time or quota) is kept but reported: moving to another candidate would
    // make mobile and desktop describe different pages.
    if (got.length) {
      process.stderr.write(`audit: ${g.name} INCOMPLETE — missing ${STRATEGIES.filter(s => !result[s]).join(", ")}: ${reason(lastErr)}\n`);
      return { ok: true, incomplete: STRATEGIES.filter(s => !result[s]), page: Object.assign({ url: u, title: g.name }, result) };
    }
    // Budget and quota problems aren't about the URL; don't burn candidates on them.
    if (errs.some(e => e.kind === "budget" || e.kind === "quota")) break;
  }
  return { ok: false, error: lastErr };
}

// ------------------------------------------------------------------- main

(async () => {
  const src = JSON.parse(fs.readFileSync(input, "utf8"));
  const outcomes = await Promise.all(src.groups.map(g => measureGroup(g).then(o => ({ g, o }))));

  const groups = [];
  const skipped = [];
  const incomplete = [];
  let lighthouseVersion = null;
  for (const { g, o } of outcomes) {
    if (!o.ok) {
      const r = reason(o.error);
      skipped.push({ name: g.name, reason: r, kind: (o.error && o.error.kind) || null });
      process.stderr.write(`audit: ${g.name} SKIPPED — ${r}\n`);
      continue;
    }
    if (o.incomplete) incomplete.push({ name: g.name, missing: o.incomplete });
    for (const s of STRATEGIES) if (o.page[s] && o.page[s].lighthouseVersion) lighthouseVersion = o.page[s].lighthouseVersion;
    const out = { name: g.name, pattern: g.pattern, totalPages: g.totalPages, pages: [o.page] };
    if (g.provisional) out.provisional = true;
    if (g.notInSitemap) out.notInSitemap = true;
    groups.push(out);
  }

  const origin = src.origin || ("https://" + src.site);
  const field = {};
  for (const s of STRATEGIES) {
    if (originField[s]) field[s] = { metrics: originField[s], collectionPeriod: null };
    else if (groups.some(g => g.pages[0][s])) field[s] = { unavailable: "not enough real-user data for this origin" };
  }

  const run = {
    site: src.site,
    origin,
    engine: "psi",
    lighthouseVersion,
    strategies: STRATEGIES,
    runsPerPage: RUNS,
    generated: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    groups,
    skipped,
    incomplete,
    crux: Object.keys(field).length ? { origin, source: "psi", fetchedAt: new Date().toISOString(), field } : null,
    // Carried from apply-config.js so an unattended run leaves a visible trace
    // when the site's structure no longer matches the saved config.
    drift: src.drift || null,
    configApplied: !!src.configApplied
  };

  const json = JSON.stringify(run, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  else console.log(json);

  const secs = Math.round((Date.now() - START) / 1000);
  console.error(`audit: ${groups.length} groups measured (median of ${RUNS}), ${skipped.length} skipped` +
    (incomplete.length ? `, ${incomplete.length} incomplete` : "") + ` in ${secs}s` + (OUT ? ` -> ${OUT}` : ""));
  if (quotaExhausted) {
    console.error(`audit: STOPPED EARLY — ${quotaExhausted}`);
    process.exitCode = 3;
  }
  if (skipped.some(x => x.kind === "budget") || incomplete.length) {
    console.error("audit: some groups ran out of time — rerun just those groups (smaller --size in split.js, or a higher --deadline if the shell allows)");
  }
})().catch(e => { console.error("audit: " + reason(e)); process.exit(1); });
