#!/usr/bin/env node
// Merge per-strategy runs into one run document for the dashboard.
// Usage: node merge.js run-mobile.json run-desktop.json --out run.json
//
// audit.js can measure both strategies in one pass, but ten Lighthouse runs
// can exceed a single command's time limit. Measuring one strategy per
// command and merging here keeps each step short.

const fs = require("fs");

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith("--") && a !== args[args.indexOf("--out") + 1]);
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const OUT = getFlag("out", null);

if (files.length < 1) {
  console.error("usage: node merge.js run-a.json run-b.json --out run.json");
  process.exit(1);
}

const runs = files.map(f => JSON.parse(fs.readFileSync(f, "utf8")));
const byGroup = new Map();
const strategies = [];
const skipped = [];

for (const run of runs) {
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
        existing = { url: p.url, title: p.title || g.name };
        target.pages.push(existing);
      }
      for (const s of rs) {
        // audit.js nests per strategy; a single-strategy run may be flat.
        const block = p[s] || (typeof p.score === "number" ? { score: p.score, metrics: p.metrics, opportunities: p.opportunities } : null);
        if (block) existing[s] = block;
      }
    }
  }
}

// Drop groups that ended up with no measurements at all.
const groups = [...byGroup.values()].filter(g => g.pages.some(p => strategies.some(s => p[s])));

const drift = runs.map(r => r.drift).find(Boolean) || null;

const merged = {
  site: runs[0].site,
  origin: runs.map(r => r.origin).find(Boolean) || ("https://" + runs[0].site),
  strategies,
  runsPerPage: runs.map(r => r.runsPerPage).find(Boolean) || null,
  generated: new Date().toISOString().slice(0, 10),
  generatedAt: new Date().toISOString(),
  groups,
  skipped,
  drift,
  configApplied: runs.every(r => r.configApplied)
};

const json = JSON.stringify(merged, null, 2);
if (OUT) {
  fs.writeFileSync(OUT, json);
  console.error(`merge: ${groups.length} groups, strategies: ${strategies.join(", ")} -> ${OUT}`);
} else {
  console.log(json);
}
