#!/usr/bin/env node
// Build the desktop groups file from the mobile results.
// Usage: node resolve.js groups-final.json m-0.json m-1.json ... --out resolved.json
//
// audit.js may fall back from a group's sample to one of its candidates when
// the sample fails. Desktop must measure the SAME page mobile measured, or the
// two numbers in the dashboard describe different pages. This takes the URL
// each group actually got measured on, and drops groups mobile had to skip.
// Site metadata (origin, drift, configApplied) is carried over unchanged.

const fs = require("fs");

const args = process.argv.slice(2);
const OUT = (() => { const i = args.indexOf("--out"); return i === -1 ? null : args[i + 1]; })();
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const [groupsFile, ...mobileFiles] = files;

if (!groupsFile || !mobileFiles.length) {
  console.error("usage: node resolve.js groups-final.json m-0.json [m-1.json ...] --out resolved.json");
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(groupsFile, "utf8"));
const measured = new Map();
for (const f of mobileFiles) {
  const run = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const g of run.groups || []) {
    const p = (g.pages || [])[0];
    if (p && p.url) measured.set(g.name, p.url);
  }
}

const groups = base.groups
  .filter(g => measured.has(g.name))
  .map(g => Object.assign({}, g, { sample: measured.get(g.name), candidates: [] }));

const dropped = base.groups.filter(g => !measured.has(g.name)).map(g => g.name);
const result = Object.assign({}, base, { groups, groupCount: groups.length });

fs.writeFileSync(OUT || "/dev/stdout", JSON.stringify(result, null, 2));
console.error(`resolve: ${groups.length} groups for desktop` +
  (dropped.length ? ` (not measured on mobile, dropped: ${dropped.join(", ")})` : ""));
