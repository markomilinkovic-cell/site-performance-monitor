#!/usr/bin/env node
// Group crawled URLs into template clusters and pick one representative per group.
// Usage: node group.js urls.json [--out groups.json] [--split-depth]
//
// Grouping is by the FIRST path segment, because that is what determines the
// template on almost every site: /docs/* is one layout no matter how deep it
// nests, /tag/* is one layout, root-level pages are one layout. Splitting by
// full path depth produces dozens of groups that all render identically,
// which defeats the point of sampling.
// Pass --split-depth to also separate a section's index page from its details.

const fs = require("fs");

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith("--"));
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const OUT = getFlag("out", null);
const SPLIT_DEPTH = args.includes("--split-depth");

if (!input) {
  console.error("usage: node group.js urls.json [--out groups.json] [--split-depth]");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(input, "utf8"));
const urls = data.urls || data;

const LABELS = {
  blog: "Blog", news: "News", docs: "Documentation", doc: "Documentation",
  documentation: "Documentation", pricing: "Pricing", features: "Features",
  tag: "Tags", tags: "Tags", category: "Categories", categories: "Categories",
  author: "Authors", authors: "Authors", product: "Products", products: "Products",
  support: "Support", help: "Help", about: "About", contact: "Contact",
  integrations: "Integrations", integration: "Integrations", compare: "Comparisons",
  alternatives: "Alternatives", resources: "Resources", guides: "Guides",
  templates: "Templates", page: "Pagination"
};

function label(seg) {
  if (seg === null) return "Home";
  if (seg === "") return "Root pages";
  const l = LABELS[seg.toLowerCase()];
  if (l) return l;
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, " ");
}

function keyOf(pathname) {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return { key: null, depth: 0 };
  if (segs.length === 1) return { key: "", depth: 1 };
  return { key: segs[0].toLowerCase(), depth: segs.length };
}

function patternFor(key, depth) {
  if (key === null) return "/";
  if (key === "") return "/*";
  return depth === 1 ? "/" + key : "/" + key + "/*";
}

// Ranked shortest-first. The first entry is the sample; the rest are
// fallbacks for audit.js, because sitemaps routinely list dead URLs and
// losing a whole group to one 404 is worse than measuring its neighbour.
function ranked(list) {
  return [...list].sort((a, b) => {
    const la = new URL(a).pathname.length, lb = new URL(b).pathname.length;
    return la !== lb ? la - lb : a.localeCompare(b);
  });
}

const buckets = new Map();
for (const u of urls) {
  let p;
  try { p = new URL(u).pathname; } catch { continue; }
  const { key, depth } = keyOf(p);
  const isIndex = key !== null && key !== "" && depth === 1;
  const bucketKey = key === null ? "\u0000home" : (SPLIT_DEPTH && isIndex ? key + "\u0000index" : key);
  if (!buckets.has(bucketKey)) buckets.set(bucketKey, { key, urls: [], indexOnly: SPLIT_DEPTH && isIndex });
  buckets.get(bucketKey).urls.push(u);
}

let groups = [...buckets.values()].map(b => {
  const maxDepth = Math.max(...b.urls.map(u => new URL(u).pathname.split("/").filter(Boolean).length));
  const order = ranked(b.urls);
  return {
    name: label(b.key) + (b.indexOnly ? " (index)" : ""),
    pattern: patternFor(b.key, b.indexOnly ? 1 : maxDepth),
    totalPages: b.urls.length,
    sample: order[0],
    candidates: order.slice(1, 4)
  };
}).sort((a, b) => (a.pattern === "/" ? -1 : b.pattern === "/" ? 1 : b.totalPages - a.totalPages));

// Fold one-page sections into a single group so a long tail doesn't dominate.
const keepSet = new Set(groups.filter(g => g.totalPages >= 2 || g.pattern === "/" || g.pattern === "/*"));
const tail = groups.filter(g => !keepSet.has(g));
groups = groups.filter(g => keepSet.has(g));
if (tail.length > 1) {
  groups.push({
    name: "Individual pages",
    pattern: "/(other)",
    totalPages: tail.reduce((n, g) => n + g.totalPages, 0),
    sample: tail[0].sample,
    candidates: tail.slice(1, 4).map(g => g.sample)
  });
} else if (tail.length === 1) {
  groups.push(tail[0]);
}

const result = {
  site: data.site,
  origin: data.origin,
  totalUrls: urls.length,
  groupCount: groups.length,
  groups
};

const json = JSON.stringify(result, null, 2);
if (OUT) {
  fs.writeFileSync(OUT, json);
  console.error(`group: ${urls.length} urls -> ${groups.length} groups -> ${OUT}`);
} else {
  console.log(json);
}
