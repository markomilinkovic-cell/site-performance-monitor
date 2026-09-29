---
name: site-perf-report
description: Measures website performance end to end — reads the pages to track for each site from the "Page Speed Tracker" Google Sheet, measures every listed page with Lighthouse through the PageSpeed Insights API, health-checks every URL in the sitemap for server errors, and publishes the results to a shared dashboard artifact that keeps measurement history. Use this skill whenever the user asks about a site's performance, page speed, Core Web Vitals, Lighthouse scores, LCP/CLS/TBT, why a site is slow, or wants a performance report or audit for any URL — even if they don't name Lighthouse or this skill explicitly. Also use it when they ask to re-measure, re-run, or update an existing performance report.
---

# Site performance report

Measure the pages listed for a site in the Page Speed Tracker sheet with PageSpeed Insights
(Google's hosted Lighthouse), health-check the whole sitemap, write the result to the site's
dashboard.

**The sheet is the single source of truth for what gets measured.** Each site has its own tab
(columns `Website | Page Type | URL`); every row is measured as its own entry. There is no
grouping: pages on these sites rarely share a template closely enough for one to stand in for
another, so nothing is inferred from URL patterns. To start or stop tracking a page, edit the
sheet — the next run picks it up. Nothing about the page list lives in this repository or in the
dashboards.

Author, category and tag archives are never measured (`excludePaths` in `sites.json`), even if
someone adds one to the sheet; `pages.js` reports such rows as skipped.

The crawl is kept, but **only for the health check**: every URL in the sitemap is requested once
per run and anything answering 5xx is reported. Crawled pages are never measured.

## What the user gets

A shared dashboard artifact with a mobile/desktop toggle showing, per tracked page: the
Lighthouse performance score (0–100), LCP, FCP, TBT, CLS, Speed Index, TTI, and the top
opportunities — plus CrUX field data (real Chrome users, 28-day rolling) for the origin, which the
PSI response includes whenever Google has enough traffic for the site, and the health-check
result (server errors, pages not found, failed sitemaps).

**The dashboard UI is in English.** Entry names are the sheet's Page Type, or Page Type plus the
last path segment when a type appears more than once (`Blog Post · nps-survey-questions`). History
and deltas are matched by that name, so renaming a Page Type or moving a URL in the sheet starts a
new history line for that page.

## Workflow

Two modes: **interactive** (a person asked in chat) and **unattended** (a scheduled routine with
nobody to ask). They differ only in step 5 — see "Unattended runs" below.

### 1. Set up

Nothing to install: Lighthouse runs on Google's machines, and the scripts only need Node 18+
(for the built-in `fetch`).

`scripts/audit.js` needs a PageSpeed Insights API key in `PSI_API_KEY`. Without one, PSI shares a
single public quota that is permanently exhausted and every call answers 429. The key is free
(Google Cloud project → enable "PageSpeed Insights API" → create an API key, restricted to that
API); the default quota is 25,000 calls a day, far more than this skill uses.

- In a scheduled routine the key comes from the cloud environment — nothing to do. Either
  `PSI_API_KEY` is an environment variable, or the key is stored as an API credential that the
  agent proxy attaches to `www.googleapis.com` requests and `PSI_KEY_FROM_PROXY=1` is set instead
  (see ROUTINE.md). `audit.js` sends the key in the `X-Goog-Api-Key` header, never in the URL.
- In chat, **don't ask the user to paste the key**. If they already have, use it only as an
  environment variable on the command (`PSI_API_KEY=... node scripts/audit.js ...`), never write it
  into a file, a run document or the repository, and suggest they restrict or rotate it.
  `audit.js` redacts the key from every log line and from its output.

If `audit.js` exits with code 2 the key is missing; with code 3 PSI rejected it or the daily quota
ran out (in proxy mode, usually a credential that wasn't attached) — stop and report that rather
than retrying.

### 2. Read the page list from the sheet

```bash
node scripts/pages.js --site ivyforms.com --sites sites.json --out /tmp/pages.json
```

`sites.json` holds the sheet id (`pagesSheet.id`) and each site's tab name (`sheetTab`). The
script reads the tab through the sheet's public CSV endpoint, which works without credentials only
while the sheet is shared as **Anyone with the link: Viewer**. It exits with:

- **4, SHEET UNREADABLE** — sharing was changed, the sheet id is wrong, or `docs.google.com` isn't
  reachable from the environment. Stop and report it; do not fall back to an old page list.
- **5, NO PAGES** — the tab is empty, or every row is on another host (a renamed tab makes the
  CSV endpoint return the first tab instead of an error; the host check catches that).

Rows it skips (empty or malformed URL, another host, duplicate, excluded archive) are listed on
stderr. Pass them on to the user — they are mistakes in the sheet someone should fix.

In chat, if the sheet can't be read publicly but the Google Drive connector is available, you may
read the tab with it, save it as CSV and pass `--csv file.csv`. Routines don't do this (see
ROUTINE.md).

### 3. Crawl and health-check

```bash
node scripts/crawl.js https://ivyforms.com --out /tmp/urls.json
node scripts/health.js /tmp/urls.json --pages /tmp/pages.json --deadline 540 --out /tmp/health.json
```

`crawl.js` reads `sitemap.xml` (following indexes and `robots.txt`) and falls back to following
links from the homepage. `health.js` requests every crawled URL plus every tracked page, 8 at a
time, and retries a 5xx or network failure once after a few seconds; only a URL that fails twice
is reported. It lists server errors, 404/410 (a sitemap advertising dead pages) and network
errors separately, and counts 403/429 as "blocked" — usually bot protection against the
checker's IP, not a broken page. A sitemap file that itself fails to load is carried into the
result as `failedSitemaps`; the pages listed only there were not checked, so say so.

About 380 URLs take ~30 s. In claude.ai chat use `--deadline 270`.

### 4. Measure both form factors, in five bursts

Measure mobile and desktop. They are scored separately by Google and routinely differ by 30
points on the same page — a site can look fine on desktop while failing on mobile, and
reporting only one number hides that.

**Why bursts.** PSI results drift over minutes, not just between calls: two identical 10-run
batches of trafft.com two minutes apart had desktop medians 89.5 and 81, and their typical
ranges didn't overlap (TBT median 166 vs 339 ms). More runs in one moment only shrink the noise
of that moment. So each page is measured in **5 bursts of 5 runs** (`--runs 5`, the default),
bursts spread across the session, and `merge.js` pools all 25 runs per page and form factor into
the median, the typical range (narrowest interval holding 60% of the runs) and the full spread.
Every run is kept in the run document as a sample.

**How the time works.** One PSI call takes 15–80s; `audit.js` runs 10 in parallel
(`--concurrency 10`; at 20, a third of the calls failed or timed out, so don't raise it). That is
~10–20 calls a minute. One burst of one page is 10 calls (5 runs × 2 form factors), so a burst of a 25-page site is
~250 calls, 12–25 minutes, and all five bursts about 1–2 hours.

**Budget the commands.** Commands have a time limit — 300s in claude.ai chat; in Claude Code the
shell tool's timeout, which is 2 minutes unless a longer one (up to 10 minutes) is passed.
`--deadline` (seconds, default 270) makes `audit.js` stop starting new calls before the limit and
still write its output. Chunk the page list so a chunk fits:

- claude.ai chat: `--size 2`, `--deadline 270`
- Claude Code: pass a 600000 ms timeout to the shell tool, then `--size 5`, `--deadline 540`

Every page has exactly one URL (no candidates), so all five bursts use the same chunk files:

```bash
# chunks that fit one command each
node scripts/split.js /tmp/pages.json --size 5 --prefix /tmp/g-

# burst k (1..5), one command per chunk
node scripts/audit.js /tmp/g-0.json --burst 1 --deadline 540 --out /tmp/b1-0.json
node scripts/audit.js /tmp/g-1.json --burst 1 --deadline 540 --out /tmp/b1-1.json
# ...

# one run document from every burst and chunk, with the health check attached
node scripts/merge.js /tmp/b*-*.json --health /tmp/health.json --out /tmp/run.json
```

(`PSI_API_KEY=...` in front of each `audit.js` when the key isn't already in the environment.)

**Spacing.** The point is time between bursts. With 10 or more pages, one burst of the whole
site already takes 10+ minutes, so running burst 1 of every chunk, then burst 2 of every chunk,
and so on spaces each page's bursts naturally. With fewer pages, wait between bursts
(`sleep 600`, ten minutes, as its own command). Several sites in one session: interleave them
(burst 1 of every site, then burst 2 …).

**Write early, overwrite later.** `merge.js` sets `generatedAt` to the first burst's start, so
every merge of the same measurement has the same doc id. Write a provisional run after burst 1
and again after bursts 3 and 5 (same doc id, `set` replaces it). If the session ends early, the
dashboard still has the bursts measured so far; the run shows how many.

**Reruns.** A page skipped for time, or with a form factor missing in a burst, simply has fewer
samples; the pooled result is still valid. Only if a page ends with fewer than 15 runs on a form
factor, measure it once more (a pages file with just that entry, `--burst 6`) and merge again
with that file included — samples are added, never replaced. A wide spread alone is normal for PSI
and is not a reason to rerun. If a command is killed by the shell before `--deadline`, its output
file is never written — rerun that chunk with a lower `--deadline` or smaller `--size`.

`--strategy mobile` / `desktop` still work for a single form factor; keep both form factors in
the same command so they're measured on the same URL.

Two failures are handled automatically, and both are worth reporting because they say
something real about the site:

- **A dead URL.** Each URL is preflighted with a plain GET first — PSI reports a 404 page as a
  generic HTTP 500, indistinguishable from a transient failure — and a 404/410 page is skipped
  with that reason. A tracked page that 404s means the sheet points at a page that no longer
  exists: tell the user to fix the row.
- **A redirect to another path.** If a URL lands somewhere else — usually the homepage — the
  measurement is discarded; without this check the report would show the homepage's numbers
  under another page's name. Usually the sheet has an old URL; the fix is the new URL in the row.

Always tell the user which pages were skipped and why.

### 4b. Field data (automatic)

Lighthouse answers "why is this slow". CrUX answers "is it slow for the people actually using
it" — a 28-day rolling aggregate of real Chrome visits. They disagree often, and when they do
the field data wins for prioritisation.

The PSI response carries the origin's CrUX data, so `audit.js` attaches it to the run as `crux`
(per form factor) and the dashboard shows it — no extra key or step. A site with too little
traffic gets `unavailable` instead, and the dashboard says so. When Google has enough data for an
individual measured URL, that page's own field numbers are stored on its strategy block as `field`.

`scripts/crux.js` (separate Chrome UX Report API key in `CRUX_API_KEY`) is no longer part of the
workflow; it would overwrite `crux` with the same origin data.

### 5. Publish

This skill maintains **one** dashboard per site and appends runs to it.

`write_db` only accepts file paths under `/mnt/user-data/outputs/` in claude.ai chat. Copy the run
file there first when running in chat. (In Claude Code, pass the file the tool accepts.)

1. Find the dashboard with the Artifact tool, action `list`, matching the site in the title.
2. **If it exists**: write the run with `write_db`, `db_op: "set"`, `collection: "runs"`,
   `doc_id` set to the run timestamp with colons replaced by dashes (e.g.
   `2026-09-22T10-30-00Z`), and the run file as `file_path`. **Don't republish the page** —
   only the data changes, and every viewer sees it on next load.
3. **If it doesn't exist** (interactive mode only): publish `assets/dashboard.html` with
   `capabilities: {db: {}}` and a title like `Site performance — example.com`, write the run into
   its database, and add the site, its sheet tab and the new dashboard link to `sites.json`.

The dashboards' `config/groups` documents from the earlier grouping workflow are no longer read;
leave them alone.

Run documents must contain `site`, `strategies`, `generated`, `generatedAt`, and `groups`;
`merge.js` emits exactly this, so pass its output unchanged.

### 6. Report back

Give the user the artifact link plus a two or three sentence read of the results in chat: which
page is worst, which metric is dragging the score down, and the single biggest opportunity.
Lead with any server error from the health check and any sheet rows `pages.js` skipped.
Don't recite every number — the dashboard shows those.

## Unattended runs (scheduled routine)

A routine runs this skill with nobody watching and nobody to answer questions. Rules:

- **Never publish a new artifact.** Publishing asks for approval, which stalls an unattended run.
  Only write to dashboards that already exist, as listed in `sites.json` at the repository root.
- **Never republish an existing dashboard page.** Only `write_db`. Data writes don't need the
  page republished.
- **The page list comes only from the sheet, read at the start of the run.** Don't add, drop or
  substitute pages yourself, and don't reuse a previous run's list. If `pages.js` exits 4 or 5,
  skip measuring that site (still run the health check) and put the error at the top of the
  summary.
- **Don't modify the sheet, `sites.json`, or anything in the repository.**
- **If `audit.js` exits with code 3** (key rejected or daily PSI quota used up), stop measuring
  every remaining site — they would all fail the same way — and say so at the top of the summary.
- **Prepare first** (sheet → crawl → health check → split), then **measure in five rounds**:
  round k runs burst k of every chunk (of every site, if there are several). After rounds 1, 3
  and 5, merge with `--health` and write the run (same doc id each time). A session that stops
  midway still leaves the dashboard with the bursts measured so far.
- **End with a summary**: health-check server errors and failed sitemaps first, then sheet rows
  that were skipped and why, then whether the run was written and with how many bursts, the
  median and typical range for mobile and desktop per page, and any skipped pages with reasons.
  That summary is the only place a human will see problems.

## Things worth telling the user

- **Lighthouse is a lab measurement, and it is noisy — on PSI too.** PSI takes the measuring
  machine out of our hands, but Google's machines still vary. Five PSI runs of trafft.com's
  homepage started at the same moment scored 58–75 on mobile and 68–95 on desktop. The spread
  comes through TBT (desktop 84–630 ms), following the CPU speed of the machine Google assigned
  (`benchmarkIndex` 598–1166). It is not the server: across 26 later runs the lab TTFB stayed
  around 7 ms (Google hits the CDN cache) and the FCP median stayed at 2.9 s. (Slow TTFB in the
  CrUX block is real, but it's what real visitors get, not the lab.)
  So **a single run on pagespeed.web.dev differing from the dashboard by ~10 points is expected**
  — the web UI is one draw from that range, the dashboard is the median of 25 runs in 5 bursts.
  Neither more runs nor a different statistic brings this to zero: the conditions on Google's
  side change within minutes. Five bursts roughly halve the week-to-week wobble of the median.
  Wide spreads are normal here; don't rerun a page just because its spread is wide.
- **Read changes against the typical range, not the median alone.** The dashboard calls a
  change real only when this run's typical range and the previous run's don't overlap; otherwise
  it says "within noise". For a suspected regression, compare the raw metrics rather than the
  score — a real regression shows up as a moved LCP or a genuinely larger TBT, not as a 4-point
  score wobble.
- **Scores measured before the switch to PSI aren't comparable with PSI scores.** Older runs
  were local Lighthouse on whatever machine ran the skill. Runs now carry `source: "psi"` (and
  `engine: "psi"`); the dashboard labels each run's source, shows other-source runs dashed in the
  history, and only computes deltas between runs of the same source. Treat the first PSI run as
  the new baseline.
- **The dashboard is organization-internal.** A page that stores data can't be shared by public
  link, so colleagues need to be in the same organization and signed in.
- **Only the dashboard's owner can add runs to it.** If a colleague runs this skill, they'll get
  their own dashboard rather than adding to someone else's.

## Files

- `scripts/pages.js` — reads a site's tab of the Page Speed Tracker sheet → pages file
  `{site, origin, pagesSource, groups[]}` (one entry per row; "groups" is the format name only)
- `scripts/crawl.js` — sitemap or link crawl → `{site, origin, source, count, urls, failedSitemaps}`;
  used only for the health check
- `scripts/health.js` — requests every crawled and tracked URL, reports 5xx, 404 and failed sitemaps
- `scripts/audit.js` — PageSpeed Insights over the pages, both form factors, parallel; attaches
  CrUX origin data (needs `PSI_API_KEY`)
- `scripts/split.js` — splits a pages file into chunks that fit a command's time limit
- `scripts/merge.js` — pools chunks, bursts and reruns into the run document the dashboard reads;
  `--health` attaches the health check
- `scripts/stats.js` — median, typical range and sample pooling, shared by audit.js and merge.js
- `scripts/crux.js` — legacy: CrUX via its own API (`CRUX_API_KEY`); PSI already supplies this
- `assets/dashboard.html` — the dashboard page, published once per site
