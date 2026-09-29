#!/usr/bin/env node
// List the serious problems in a run, and later stamp Jira matches onto it.
//
// List:  node issues.js --health health.json [--run run.json] --out issues.json
// Stamp: node issues.js --stamp run.json --issues issues.json
//
// A Jira task is warranted only for:
//   - a URL that answered 5xx twice (health.js serverErrors)
//   - a sitemap file that failed to load
//
// A score drop is a notification in the summary and the Slack message, not a task.
// Also not listed: 404s, blocked or network failures, sheet rows skipped, pages
// skipped while measuring. This script does not call Jira.

const fs = require("fs");

const BOARD = "https://tmsplugins.atlassian.net/jira/software/projects/WEB/boards/30";
const BROWSE = "https://tmsplugins.atlassian.net/browse/";

const args = process.argv.slice(2);
const getFlag = (n, d) => { const i = args.indexOf("--" + n); return i === -1 ? d : args[i + 1]; };
const HEALTH = getFlag("health", null);
const RUN = getFlag("run", null);
const OUT = getFlag("out", null);
const STAMP = getFlag("stamp", null);
const ISSUES = getFlag("issues", null);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function asRun(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (Array.isArray(raw)) return asRun(raw[0]);
  if (raw.health || raw.groups) return raw;
  if (raw.data) return asRun(raw.data);
  return null;
}

function jqlPhrase(text) {
  return '"' + String(text).replace(/[\\"]/g, "\\$&") + '"';
}

function searchText(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "/" : u.pathname.replace(/\/$/, "");
    return u.host + path + u.search;
  } catch {
    return String(url);
  }
}

function jql(kind, url) {
  const phrase = `text ~ ${jqlPhrase(searchText(url))}`;
  const kindClause = kind === "server-error"
    ? '(text ~ "5xx" OR text ~ "\\"server error\\"")'
    : 'text ~ "sitemap"';
  return `project = WEB AND statusCategory != Done AND ${phrase} AND ${kindClause} ORDER BY updated DESC`;
}

function problem(fields) {
  return Object.assign({
    strategy: null,
    key: null,
    browseUrl: null
  }, fields, { jql: jql(fields.kind, fields.url) });
}

function listProblems(health, run) {
  const problems = [];
  const h = health || (run && run.health) || null;
  if (h) {
    for (const e of h.serverErrors || []) {
      problems.push(problem({
        id: "server-error|" + e.url,
        kind: "server-error",
        subject: e.url,
        url: e.url,
        detail: `${e.status} ${e.url}${e.tracked ? " (tracked page)" : ""} — answered 5xx twice`,
        suggest: `5xx ${e.url}`
      }));
    }
    for (const f of h.failedSitemaps || []) {
      problems.push(problem({
        id: "sitemap|" + f.url,
        kind: "sitemap",
        subject: f.url,
        url: f.url,
        detail: `Sitemap fetch failed ${f.url} (${f.status})`,
        suggest: `Sitemap fetch failed ${f.url}`
      }));
    }
  }

  return problems;
}

function list() {
  if (!OUT || (!HEALTH && !RUN)) {
    console.error("usage: node issues.js --health health.json [--run run.json] --out issues.json");
    console.error("       node issues.js --stamp run.json --issues issues.json");
    process.exit(1);
  }
  const health = HEALTH ? readJson(HEALTH) : null;
  const run = RUN ? asRun(readJson(RUN)) : null;
  const problems = listProblems(health, run);
  const doc = {
    checked: false,
    project: "WEB",
    boardUrl: BOARD,
    problems
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  console.error(`issues: ${problems.length} serious problem(s) -> ${OUT}`);
  console.error("issues: Jira was not queried. Search each problem's jql, set key and browseUrl, then set checked to true.");
  for (const p of problems) console.error(`  [${p.kind}] ${p.detail}\n    ${p.jql}`);
}

function stamp() {
  if (!STAMP || !ISSUES) {
    console.error("usage: node issues.js --stamp run.json --issues issues.json");
    process.exit(1);
  }
  const found = readJson(ISSUES);
  if (!found || found.checked !== true) {
    console.error("issues: not stamped — checked is not true. Search Jira first, or leave the run unmarked if the search failed.");
    process.exit(2);
  }
  const run = readJson(STAMP);
  run.issuesChecked = true;
  run.issues = (found.problems || []).map(p => ({
    id: p.id,
    kind: p.kind,
    subject: p.subject,
    strategy: p.strategy || null,
    url: p.url,
    detail: p.detail,
    suggest: p.suggest || null,
    key: p.key || null,
    browseUrl: p.key ? (p.browseUrl || (BROWSE + p.key)) : null
  }));
  fs.writeFileSync(STAMP, JSON.stringify(run));
  const linked = run.issues.filter(p => p.key).length;
  console.error(`issues: stamped ${run.issues.length} problem(s), ${linked} with a Jira key -> ${STAMP}`);
}

if (STAMP || ISSUES) stamp();
else list();
