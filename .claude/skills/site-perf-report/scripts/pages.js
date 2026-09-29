#!/usr/bin/env node
// Read the list of pages to measure for one site from the "Page Speed Tracker"
// Google Sheet and emit a groups file that split.js / audit.js understand.
//
// Usage: node pages.js --site ivyforms.com [--sites ../../../../sites.json]
//                      [--csv local.csv] [--out /tmp/groups.json]
//
// Every row of the site's tab is measured as its own entry — no grouping.
// Pages on a site rarely share a template closely enough for one to stand in
// for another, so the sheet names exactly what is measured, and editing the
// sheet is the only thing needed to change it.
//
// The sheet is read through its CSV endpoint
// (docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&sheet=<tab>),
// which needs no credentials but only works when the sheet is shared as
// "Anyone with the link: Viewer". --csv reads a local export instead (tests,
// or a sheet that can't be shared).
//
// Expected columns (header row, any order, case-insensitive):
//   Website | Page Type | URL
// Only URL is required. Rows are skipped, with a warning, when the URL is
// empty or malformed, belongs to another host, repeats an earlier row, or
// matches one of sites.json "excludePaths" (author, category and tag archives).
//
// Exit codes: 0 ok, 1 usage, 4 sheet unreadable, 5 no measurable rows.

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const SITE = getFlag("site", null);
const SITES = getFlag("sites", path.resolve(__dirname, "../../../../sites.json"));
const CSV = getFlag("csv", null);
const OUT = getFlag("out", null);

if (!SITE) {
  console.error("usage: node pages.js --site example.com [--sites sites.json] [--csv file.csv] [--out groups.json]");
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(SITES, "utf8"));
const entry = (cfg.sites || []).find(s => s.site === SITE);
if (!entry) { console.error(`pages: ${SITE} is not in ${SITES}`); process.exit(1); }
const sheetId = (cfg.pagesSheet && cfg.pagesSheet.id) || null;
const tab = entry.sheetTab || null;
const excludePaths = cfg.excludePaths || [];
const origin = entry.origin || ("https://" + SITE);
const host = new URL(origin).host.replace(/^www\./, "");

// ------------------------------------------------------------------ CSV

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(Boolean));
}

async function readSheet() {
  if (CSV) return { text: fs.readFileSync(CSV, "utf8"), from: CSV };
  if (!sheetId || !tab) {
    console.error(`pages: sites.json needs "pagesSheet": {"id": ...} and "sheetTab" for ${SITE}`);
    process.exit(1);
  }
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?` +
    new URLSearchParams({ tqx: "out:csv", sheet: tab });
  let res, text;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
    text = await res.text();
  } catch (e) {
    console.error(`pages: SHEET UNREADABLE — ${e.name === "TimeoutError" ? "timeout" : e.message}. ` +
      "Is docs.google.com in the environment's network allowlist?");
    process.exit(4);
  }
  const type = res.headers.get("content-type") || "";
  if (res.status !== 200 || /text\/html/i.test(type)) {
    console.error(`pages: SHEET UNREADABLE — HTTP ${res.status} (${type.split(";")[0] || "no content type"}). ` +
      (res.status === 401 || res.status === 403 || /text\/html/i.test(type)
        ? "The sheet is not shared as \"Anyone with the link: Viewer\", so it can't be read without signing in."
        : "Check the sheet id in sites.json."));
    process.exit(4);
  }
  // gviz answers an unknown tab name with the FIRST tab rather than an error,
  // so a renamed tab would silently measure another site. The host check
  // below catches that; say so explicitly when every row is foreign.
  return { text, from: `sheet ${sheetId}, tab "${tab}"` };
}

// ---------------------------------------------------------------- filter

function globToRe(p) {
  const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + esc + "$", "i");
}
const excludeRes = excludePaths.map(p => ({ p, re: globToRe(p) }));

(async () => {
  const { text, from } = await readSheet();
  const rows = parseCsv(text);
  const hi = rows.findIndex(r => r.some(c => /^url$/i.test(c)));
  if (hi === -1) {
    console.error(`pages: SHEET UNREADABLE — no "URL" column header in ${from}`);
    process.exit(4);
  }
  const head = rows[hi].map(c => c.toLowerCase());
  const col = name => head.findIndex(c => c === name);
  const cUrl = col("url"), cType = col("page type"), cSite = col("website");

  const warnings = [];
  const seen = new Set();
  const pages = [];
  let foreign = 0;
  rows.slice(hi + 1).forEach((r, i) => {
    const line = hi + i + 2;
    const raw = (r[cUrl] || "").trim();
    const type = cType === -1 ? "" : (r[cType] || "").trim();
    if (!raw) { if (type) warnings.push(`row ${line}: "${type}" has no URL`); return; }
    let u;
    try { u = new URL(raw); } catch { warnings.push(`row ${line}: not a URL: ${raw}`); return; }
    if (!/^https?:$/.test(u.protocol)) { warnings.push(`row ${line}: not http(s): ${raw}`); return; }
    if (u.host.replace(/^www\./, "") !== host) {
      foreign++;
      warnings.push(`row ${line}: ${raw} is not on ${SITE}` +
        (cSite !== -1 && r[cSite] ? ` (Website column says ${r[cSite]})` : ""));
      return;
    }
    u.hash = "";
    const key = u.origin + u.pathname.replace(/\/+$/, "") + u.search;
    if (seen.has(key)) { warnings.push(`row ${line}: duplicate of an earlier row: ${raw}`); return; }
    const ex = excludeRes.find(x => x.re.test(u.pathname));
    if (ex) { warnings.push(`row ${line}: ${raw} matches excluded ${ex.p} — not measured`); return; }
    seen.add(key);
    pages.push({ type, url: u.href, path: u.pathname, line });
  });

  if (!pages.length) {
    console.error(`pages: NO PAGES to measure for ${SITE} in ${from}` +
      (foreign ? ` — every row is on another host; is sheetTab "${tab}" still the tab's name?` : ""));
    for (const w of warnings) console.error("  " + w);
    process.exit(5);
  }

  // Dashboard history matches entries by name, so names must be unique and
  // stable: the Page Type alone when it's unique, otherwise Page Type plus the
  // page's last path segment ("Blog Post · nps-survey-questions").
  const typeCount = {};
  for (const p of pages) typeCount[p.type] = (typeCount[p.type] || 0) + 1;
  const used = new Set();
  const groups = pages.map(p => {
    const slug = p.path.replace(/\/+$/, "").split("/").pop() || "home";
    let name = !p.type ? p.path : typeCount[p.type] > 1 ? `${p.type} · ${slug}` : p.type;
    if (used.has(name)) name = `${p.type || "Page"} · ${p.path}`;
    used.add(name);
    return { name, pattern: p.path, totalPages: 1, sample: p.url, candidates: [], pageType: p.type || null };
  });

  const result = {
    site: SITE,
    origin,
    pagesSource: { kind: CSV ? "csv" : "sheet", sheetId, tab, readAt: new Date().toISOString(), rows: pages.length },
    groupCount: groups.length,
    groups
  };
  const json = JSON.stringify(result, null, 2);
  if (OUT) fs.writeFileSync(OUT, json); else console.log(json);
  console.error(`pages: ${groups.length} pages for ${SITE} from ${from}` + (OUT ? ` -> ${OUT}` : ""));
  if (warnings.length) {
    console.error(`pages: ${warnings.length} row(s) not measured:`);
    for (const w of warnings) console.error("  " + w);
  }
})().catch(e => { console.error("pages: " + e.message); process.exit(1); });
