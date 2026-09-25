#!/usr/bin/env node
// Apply a site's saved grouping config to freshly grouped URLs.
// Usage: node apply-config.js groups.json config.json [--previous last-run.json] [--out groups-final.json]
//
// Grouping is heuristic, and the first run on a site always needs a human to
// fix it: pick a real landing page instead of a listing, drop test pages,
// drop sections that redirect, add a homepage the sitemap forgot. If those
// fixes are not saved, the next run silently measures different pages under
// the same group names and the history compares apples to oranges.
//
// The config is stored in the dashboard's own database (collection "config",
// doc "groups"), so it travels with the report and is available both in chat
// and to a scheduled routine.
//
// Config shape:
// {
//   "site": "example.com",
//   "exclude":    ["/tag/*"],                          // patterns to drop
//   "samples":    {"/*": "https://example.com/pricing"},  // fixed sample per pattern
//   "candidates": {"/*": ["https://example.com/about"]},  // fallbacks per pattern
//   "add":        [{"name","pattern","totalPages","sample"}],  // groups the crawl misses
//   "expected":   ["/", "/*", "/docs/*"],                // patterns measured last time
//   "notes":      {"/tag/*": "why it is excluded"}
// }
//
// Drift is a pattern appearing or disappearing versus "expected". Neither is
// silently fixed, but neither is silently dropped either:
//
// - A NEW section is measured with group.js's automatic sample and marked
//   provisional. The number is real, but nobody has checked that the sample
//   represents the section (the automatic pick is sometimes a listing page),
//   so the dashboard labels it and it is not added to the config.
// - A VANISHED section is measured on the URL used in the previous run (pass
//   --previous). If that page still works, the section only fell out of the
//   sitemap and its history continues, marked as such. If it 404s or
//   redirects, audit.js skips it with that reason — which answers whether the
//   section was really removed.

const fs = require("fs");

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && !["--out", "--previous"].includes(args[i - 1]));
const [groupsFile, configFile] = positional;
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const OUT = getFlag("out", null);
const PREVIOUS = getFlag("previous", null);

if (!groupsFile || !configFile) {
  console.error("usage: node apply-config.js groups.json config.json [--out groups-final.json]");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(groupsFile, "utf8"));
const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));

const exclude = new Set(cfg.exclude || []);
const samples = cfg.samples || {};
const candidates = cfg.candidates || {};
const add = cfg.add || [];

const crawledPatterns = data.groups.map(g => g.pattern);

let groups = data.groups
  .filter(g => !exclude.has(g.pattern))
  .map(g => {
    const out = Object.assign({}, g);
    if (samples[g.pattern]) out.sample = samples[g.pattern];
    if (candidates[g.pattern]) out.candidates = candidates[g.pattern].slice();
    return out;
  });

for (const extra of add) {
  if (!groups.some(g => g.pattern === extra.pattern)) {
    groups.push(Object.assign({ candidates: [] }, extra));
  }
}

// Home first, then by size — same order group.js produces.
groups.sort((a, b) => (a.pattern === "/" ? -1 : b.pattern === "/" ? 1 : b.totalPages - a.totalPages));

const expected = cfg.expected || [];
const newPatterns = groups.map(g => g.pattern).filter(p => expected.length && !expected.includes(p));
for (const g of groups) {
  if (newPatterns.includes(g.pattern)) g.provisional = true;
}

const missingPatterns = expected.filter(p => !groups.some(g => g.pattern === p));
const recovered = [];
if (missingPatterns.length && PREVIOUS) {
  const prev = JSON.parse(fs.readFileSync(PREVIOUS, "utf8"));
  for (const pattern of missingPatterns) {
    const old = (prev.groups || []).find(g => g.pattern === pattern);
    const page = old && (old.pages || [])[0];
    if (!page || !page.url) continue;
    groups.push({
      name: old.name,
      pattern,
      totalPages: old.totalPages,
      sample: page.url,
      candidates: [],
      notInSitemap: true
    });
    recovered.push(pattern);
  }
  groups.sort((a, b) => (a.pattern === "/" ? -1 : b.pattern === "/" ? 1 : b.totalPages - a.totalPages));
}

const drift = {
  newPatterns,
  missingPatterns,
  // Missing sections we could still try, using the previous run's URL.
  retriedFromPreviousRun: recovered,
  // Excluded patterns that no longer appear at all: the exclusion is stale.
  staleExcludes: [...exclude].filter(p => !crawledPatterns.includes(p)),
  // A sub-sitemap that failed (see crawl.js): every URL it would have listed
  // is invisible to this run, and — unlike newPatterns/missingPatterns —
  // that's true even the very first time a section is measured, so this
  // can't be caught by comparing against "expected" at all.
  failedSitemaps: data.failedSitemaps || []
};
const hasDrift = drift.newPatterns.length || drift.missingPatterns.length || drift.failedSitemaps.length;

const result = Object.assign({}, data, {
  groups,
  groupCount: groups.length,
  configApplied: true,
  drift: hasDrift ? drift : null
});
delete result.failedSitemaps;   // folded into drift above; don't carry it twice

if (drift.failedSitemaps.length) {
  console.error("apply-config: SITEMAP FETCH FAILED — some site content may be entirely missing from this run:");
  for (const f of drift.failedSitemaps) console.error(`  ${f.url} (${f.status})`);
}
if (hasDrift && (drift.newPatterns.length || drift.missingPatterns.length)) {
  console.error("apply-config: SITE STRUCTURE CHANGED since the config was saved");
  if (drift.newPatterns.length)
    console.error("  new sections, measured with an unreviewed sample: " + drift.newPatterns.join(", "));
  if (drift.missingPatterns.length)
    console.error("  sections missing from the crawl: " + drift.missingPatterns.join(", "));
  if (recovered.length)
    console.error("  retrying those on last run's URL: " + recovered.join(", "));
  const unrecovered = drift.missingPatterns.filter(p => !recovered.includes(p));
  if (unrecovered.length)
    console.error("  not measured at all (" + (PREVIOUS ? "no URL in previous run" : "no --previous given") + "): " + unrecovered.join(", "));
}
if (drift.staleExcludes.length) {
  console.error("apply-config: exclusions no longer matching anything: " + drift.staleExcludes.join(", "));
}

const json = JSON.stringify(result, null, 2);
if (OUT) {
  fs.writeFileSync(OUT, json);
  console.error(`apply-config: ${groups.length} groups -> ${OUT}`);
} else {
  console.log(json);
}
