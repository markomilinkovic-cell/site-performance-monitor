#!/usr/bin/env node
// Merge audit.js outputs into the one run document the dashboard reads.
// Usage: node merge.js b1-a.json b1-b.json b2-a.json ... --out run.json
//
// Inputs are chunks (a few groups per command, to fit the shell's time limit)
// and bursts (the same groups measured again later, with --burst N). For the
// same group, URL and form factor, the samples of every input are pooled and
// summarised again — median, typical range, spread — so five bursts of five
// runs become one result from 25 runs spread over the session. Pass a rerun
// like any other input: its samples are simply added.
//
// generatedAt is the earliest input's, so writing a provisional merge after
// the first burst and the final one after the last lands on the same doc id.

const fs = require("fs");
const path = require("path");
const { summarise } = require(path.join(__dirname, "stats.js"));

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const OUT = getFlag("out", null);
// The dashboard database takes documents up to 256 kB.
const MAX_BYTES = 240000;

if (files.length < 1) {
  console.error("usage: node merge.js run-a.json run-b.json ... --out run.json");
  process.exit(1);
}

const runs = files.map(f => JSON.parse(fs.readFileSync(f, "utf8")))
  .sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
const byGroup = new Map();
const strategies = [];
const skipped = [];
const incomplete = [];
const bursts = new Set();
const field = {};
let crux = null;
const pooled = new Map();   // group|url|strategy -> samples[]

for (const run of runs) {
  if (run.burst) bursts.add(run.burst);
  // Inputs are sorted oldest first, so the latest real field data wins.
  if (run.crux && run.crux.field) {
    crux = { origin: run.crux.origin, source: run.crux.source || null, fetchedAt: run.crux.fetchedAt };
    for (const [s, f] of Object.entries(run.crux.field)) {
      if (!field[s] || (f && f.metrics)) field[s] = f;
    }
  }
  for (const x of run.incomplete || []) incomplete.push(x);
  const rs = run.strategies || (run.strategy ? [run.strategy] : ["mobile"]);
  for (const s of rs) if (!strategies.includes(s)) strategies.push(s);
  for (const x of run.skipped || []) {
    if (!skipped.some(y => y.name === x.name)) skipped.push(x);
  }
  for (const g of run.groups || []) {
    if (!byGroup.has(g.name)) {
      byGroup.set(g.name, { name: g.name, pattern: g.pattern, totalPages: g.totalPages, pages: [] });
    }
    const target = byGroup.get(g.name);
    if (g.provisional) target.provisional = true;
    if (g.notInSitemap) target.notInSitemap = true;
    for (const p of g.pages || []) {
      let existing = target.pages.find(q => q.url === p.url);
      if (!existing) {
        if (target.pages.length) {
          console.error(`merge: WARNING — ${g.name} measured on more than one URL (${target.pages[0].url}, ${p.url}); ` +
            "later bursts should use the resolve.js output of the first burst");
        }
        existing = { url: p.url, title: p.title || g.name };
        target.pages.push(existing);
      }
      for (const s of rs) {
        // audit.js nests per strategy; very old single-strategy runs may be flat.
        const b = p[s] || (typeof p.score === "number" ? { score: p.score, metrics: p.metrics, opportunities: p.opportunities } : null);
        if (!b) continue;
        if (Array.isArray(b.samples) && b.samples.length) {
          const key = `${g.name}|${p.url}|${s}`;
          if (!pooled.has(key)) pooled.set(key, { page: existing, s, samples: [], field: null });
          const e = pooled.get(key);
          e.samples.push(...b.samples);
          if (b.field) e.field = b.field;
        } else {
          existing[s] = b;   // no samples (older format): later input wins
        }
      }
    }
  }
}

for (const { page, s, samples, field: f } of pooled.values()) {
  // Opportunities are only needed to pick the representative run; the final
  // document keeps them on the block, not on every sample, to stay small.
  const b = summarise(samples, { keepSampleDetail: false });
  if (f) b.field = f;
  page[s] = b;
}

// Drop groups that ended up with no measurements at all.
const groups = [...byGroup.values()].filter(g => g.pages.some(p => strategies.some(s => p[s])));

const drift = runs.map(r => r.drift).find(Boolean) || null;

// Only report what is still missing after every input is in.
const stillIncomplete = [];
for (const x of incomplete) {
  const g = groups.find(y => y.name === x.name);
  const missing = (x.missing || []).filter(s => !(g && g.pages.some(p => p[s])));
  if (missing.length && !stillIncomplete.some(y => y.name === x.name)) stillIncomplete.push({ name: x.name, missing });
}
const stillSkipped = skipped.filter(x => !groups.some(g => g.name === x.name));
const engines = [...new Set(runs.map(r => r.engine || (r.source === "psi" ? "psi" : "lighthouse")))];
const sources = [...new Set(runs.map(r => r.source || (r.engine === "psi" ? "psi" : "cli")))];
if (engines.length > 1) console.error(`merge: WARNING — mixing measurements from ${engines.join(" and ")}`);

const merged = {
  site: runs[0].site,
  origin: runs.map(r => r.origin).find(Boolean) || ("https://" + runs[0].site),
  source: sources.length === 1 ? sources[0] : "mixed",
  engine: engines.length === 1 ? engines[0] : engines.join("+"),
  lighthouseVersion: runs.map(r => r.lighthouseVersion).filter(Boolean).pop() || null,
  strategies,
  runsPerPage: runs.map(r => r.runsPerPage).find(Boolean) || null,
  bursts: [...bursts].sort((a, b) => a - b),
  generated: String(runs[0].generatedAt || new Date().toISOString()).slice(0, 10),
  generatedAt: runs[0].generatedAt || new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  groups,
  skipped: stillSkipped,
  incomplete: stillIncomplete,
  crux: crux ? Object.assign(crux, { field }) : null,
  drift,
  configApplied: runs.every(r => r.configApplied)
};

// Compact JSON: a site with 9 groups x 2 form factors x 25 samples is ~150 kB
// this way and would not fit indented.
let json = JSON.stringify(merged);
if (Buffer.byteLength(json) > MAX_BYTES) {
  // Keep the summaries and allScores; drop per-sample metrics.
  for (const g of merged.groups) for (const p of g.pages) for (const s of strategies) {
    if (p[s] && p[s].samples) p[s].samples = p[s].samples.map(x => ({ burst: x.burst, score: x.score }));
  }
  json = JSON.stringify(merged);
  console.error(`merge: document too large for the dashboard database; per-sample metrics dropped (${Buffer.byteLength(json)} bytes)`);
}

if (OUT) {
  fs.writeFileSync(OUT, json);
  const perPage = [...pooled.values()].map(e => e.page[e.s].runs);
  console.error(`merge: ${groups.length} groups, strategies: ${strategies.join(", ")}` +
    (bursts.size ? `, bursts: ${[...bursts].sort((a, b) => a - b).join(",")}` : "") +
    (perPage.length ? `, runs per page ${Math.min(...perPage)}–${Math.max(...perPage)}` : "") +
    (stillSkipped.length ? `, skipped: ${stillSkipped.map(x => x.name).join(", ")}` : "") +
    (stillIncomplete.length ? `, INCOMPLETE: ${stillIncomplete.map(x => x.name + " (" + x.missing.join("/") + ")").join(", ")}` : "") +
    `, ${Math.round(Buffer.byteLength(json) / 1024)} kB -> ${OUT}`);
} else {
  console.log(json);
}
