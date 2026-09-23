#!/usr/bin/env node
// Merge per-strategy runs into one run document for the dashboard.
// Usage: node merge.js run-mobile.json run-desktop.json --out run.json
//
// audit.js measures a few groups per command so each command fits the shell's
// time limit; this stitches the chunks (and any per-strategy runs) back into
// one run document. CrUX field data from the chunks is combined per strategy.

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
const incomplete = [];
const field = {};
let crux = null;

for (const run of runs) {
  if (run.crux && run.crux.field) {
    crux = crux || { origin: run.crux.origin, source: run.crux.source || null, fetchedAt: run.crux.fetchedAt };
    for (const [s, f] of Object.entries(run.crux.field)) {
      // Real metrics beat an "unavailable" note from a chunk that got none.
      if (!field[s] || (field[s].unavailable && f && f.metrics)) field[s] = f;
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

// A group that was incomplete in one chunk may have been completed by a rerun
// passed in alongside it; only report what is still missing.
const stillIncomplete = [];
for (const x of incomplete) {
  const g = groups.find(y => y.name === x.name);
  const missing = (x.missing || []).filter(s => !(g && g.pages.some(p => p[s])));
  if (missing.length && !stillIncomplete.some(y => y.name === x.name)) stillIncomplete.push({ name: x.name, missing });
}
// A group skipped in one chunk but measured in another (a rerun) isn't skipped.
const stillSkipped = skipped.filter(x => !groups.some(g => g.name === x.name));
const engines = [...new Set(runs.map(r => r.engine || "lighthouse"))];
if (engines.length > 1) console.error(`merge: WARNING — mixing measurements from ${engines.join(" and ")}`);

const merged = {
  site: runs[0].site,
  origin: runs.map(r => r.origin).find(Boolean) || ("https://" + runs[0].site),
  engine: engines.length === 1 ? engines[0] : engines.join("+"),
  lighthouseVersion: runs.map(r => r.lighthouseVersion).find(Boolean) || null,
  strategies,
  runsPerPage: runs.map(r => r.runsPerPage).find(Boolean) || null,
  generated: new Date().toISOString().slice(0, 10),
  generatedAt: new Date().toISOString(),
  groups,
  skipped: stillSkipped,
  incomplete: stillIncomplete,
  crux: crux ? Object.assign(crux, { field }) : null,
  drift,
  configApplied: runs.every(r => r.configApplied)
};

const json = JSON.stringify(merged, null, 2);
if (OUT) {
  fs.writeFileSync(OUT, json);
  console.error(`merge: ${groups.length} groups, strategies: ${strategies.join(", ")}` +
    (stillSkipped.length ? `, skipped: ${stillSkipped.map(x => x.name).join(", ")}` : "") +
    (stillIncomplete.length ? `, INCOMPLETE: ${stillIncomplete.map(x => x.name + " (" + x.missing.join("/") + ")").join(", ")}` : "") +
    ` -> ${OUT}`);
} else {
  console.log(json);
}
