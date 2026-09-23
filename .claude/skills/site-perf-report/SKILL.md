---
name: site-perf-report
description: Measures website performance end to end — crawls a site, groups template pages (blog, docs, tag archives, pagination) so only one representative sample per group is measured, runs Lighthouse over those samples through the PageSpeed Insights API, and publishes the results to a shared dashboard artifact that keeps measurement history. Use this skill whenever the user asks about a site's performance, page speed, Core Web Vitals, Lighthouse scores, LCP/CLS/TBT, why a site is slow, or wants a performance report or audit for any URL — even if they don't name Lighthouse or this skill explicitly. Also use it when they ask to re-measure, re-run, or update an existing performance report.
---

# Site performance report

Crawl a site, measure a representative sample of pages with PageSpeed Insights (Google's hosted
Lighthouse), publish a dashboard.

Measuring every page of a large site is slow and pointless: a blog with 140 posts renders
140 near-identical pages. This skill groups URLs by template and measures one page per group,
then says so plainly in the report so nobody mistakes a sample for full coverage.

## What the user gets

A shared dashboard artifact with a mobile/desktop toggle showing, per template group: the
Lighthouse performance score (0–100), LCP, FCP, TBT, CLS, Speed Index, TTI, and the top
opportunities — plus CrUX field data (real Chrome users, 28-day rolling) for the origin, which the
PSI response includes whenever Google has enough traffic for the site.

**The dashboard UI is in English.** Group names come from `scripts/group.js`, which labels them
in English too; keep both consistent if you localise either. Every run is appended
to the dashboard's database, so the dashboard also shows history and per-group score deltas
between runs.

## Workflow

Run these in order. **Do not skip step 3** — grouping is the one step where the algorithm can
be wrong, and a bad grouping silently produces a misleading report.

There are two modes. **Interactive** (a person asked in chat) and **unattended** (a scheduled
routine with nobody to ask). They differ only in step 3 and step 5 — see "Unattended runs" below.

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
  into a file, the config, a run document or the repository, and suggest they restrict or rotate
  it. `audit.js` redacts the key from every log line and from its output.

If `audit.js` exits with code 2 the key is missing; with code 3 PSI rejected it or the daily quota
ran out (in proxy mode, usually a credential that wasn't attached) — stop and report that rather
than retrying.

Measured while building this: 3 groups × 2 form factors × 3 runs (18 PSI calls) took about 40s
at `--concurrency 10`. Single calls ranged from ~10s to ~80s, and PSI answers an occasional
HTTP 500 "Something went wrong" on a healthy page; `audit.js` retries those twice.

### 2. Crawl

```bash
node scripts/crawl.js https://example.com --out /tmp/urls.json
```

Reads `sitemap.xml` (following sitemap indexes and `robots.txt`), and falls back to following
links from the homepage when there's no usable sitemap. Same-host pages only; assets excluded.

### 3. Group — using the saved config when there is one

```bash
node scripts/group.js /tmp/urls.json --out /tmp/groups.json
```

**First, look for a saved config.** Every dashboard stores the grouping decisions made on its
first run in its own database: collection `config`, doc `groups`. Find the site's dashboard
(Artifact `list`, match the site in the title) and read it with `read_db`, `db_op: "get"`.

**If a config exists** — also fetch the latest run (`read_db`, `db_op: "query"`, collection
`runs`, `order_by` `generatedAt` descending, `limit` 1), save both to files, and apply:

```bash
node scripts/apply-config.js /tmp/groups.json /tmp/config.json \
  --previous /tmp/last-run.json --out /tmp/groups-final.json
```

This reproduces exactly the samples measured last time, so the new run is comparable with the
history. Don't re-ask the user about grouping; they already decided.

When the script reports **SITE STRUCTURE CHANGED**, nothing is dropped:

- a **new section** is measured with the automatic sample and flagged `provisional` — the
  dashboard labels it "unreviewed sample"
- a **vanished section** is measured on the page used in the last run and flagged
  `notInSitemap`, so its history continues; if that page is really gone, `audit.js` skips the
  group with the 404 or redirect as the reason

Every other group is unaffected and compares normally. In interactive mode, tell the user what
changed and offer to update the config: review the new section's sample and add its pattern to
`expected`, or exclude it; for a vanished section, either remove it from `expected` or note that
the sitemap is broken.

**If there is no config** (first run on this site) — show the user the groups as a short table:
group name, URL pattern, page count, and the URL that will be measured. Ask whether to proceed,
adjust, or drop groups. Common corrections:

- the sample for root pages is a listing (`/blog`) → pick a real landing page (`/pricing`, `/about`)
- sections that redirect wholesale to the homepage → exclude them
- internal test or CTA pages → exclude them
- the homepage missing from the sitemap → add it
- two groups that are really one template → merge them

Verify each chosen sample returns HTTP 200 without redirecting before measuring
(`curl -s -o /dev/null -w "%{http_code} %{url_effective}" -L <url>`). `audit.js` also preflights
every URL, but a reviewed sample that's already dead makes a bad config.

**Then save those decisions as the config**, so the next run reproduces them. Shape:

```json
{
  "site": "example.com",
  "origin": "https://example.com",
  "exclude":    ["/tag/*"],
  "samples":    {"/*": "https://example.com/pricing"},
  "candidates": {"/*": ["https://example.com/about"]},
  "add":        [{"name": "Home", "pattern": "/", "totalPages": 1, "sample": "https://example.com/"}],
  "expected":   ["/", "/*", "/docs/*"],
  "notes":      {"/tag/*": "all tag URLs redirect to the homepage"},
  "updatedAt":  "2026-09-22T00:00:00Z"
}
```

`expected` is the list of patterns that end up measured; `apply-config.js` compares against it to
detect drift. Write `notes` for every exclusion and override — the next person to read the
config needs to know why. Write it with `write_db`, `set`, collection `config`, doc `groups`.

Default to 5–9 groups. More than that gets slow without adding much.

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
~10–20 calls a minute. One burst of one group is 10 calls (5 runs × 2 form factors).

**Budget the commands.** Commands have a time limit — 300s in claude.ai chat; in Claude Code the
shell tool's timeout, which is 2 minutes unless a longer one (up to 10 minutes) is passed.
`--deadline` (seconds, default 270) makes `audit.js` stop starting new calls before the limit and
still write its output. Chunk the groups so a chunk fits:

- claude.ai chat: `--size 2`, `--deadline 270`
- Claude Code: pass a 600000 ms timeout to the shell tool, then `--size 5`, `--deadline 540`

**Burst 1** settles which URL each group is measured on (preflight, candidate fallback); every
later burst must measure exactly those URLs, so it uses `resolve.js`'s output:

```bash
# chunks that fit one command each
node scripts/split.js /tmp/groups-final.json --size 5 --prefix /tmp/g-

# burst 1, one command per chunk
node scripts/audit.js /tmp/g-0.json --burst 1 --out /tmp/b1-0.json
node scripts/audit.js /tmp/g-1.json --burst 1 --out /tmp/b1-1.json

# fix the URLs for the later bursts
node scripts/resolve.js /tmp/groups-final.json /tmp/b1-*.json --out /tmp/fixed.json
node scripts/split.js /tmp/fixed.json --size 5 --prefix /tmp/f-

# bursts 2..5 — the same chunks again, later
node scripts/audit.js /tmp/f-0.json --burst 2 --out /tmp/b2-0.json
# ...

# one run document from every burst and chunk
node scripts/merge.js /tmp/b*-*.json --out /tmp/run.json
```

(`PSI_API_KEY=...` in front of each `audit.js` when the key isn't already in the environment.)

**Spacing.** The point is time between bursts. With several sites, interleave them: burst 1 of
every site, then burst 2 of every site, and so on — with four sites a round takes ~15 minutes, so
each page is sampled across about an hour. With a single site, wait between bursts instead
(`sleep 600` between them, ten minutes, as its own command).

**Write early, overwrite later.** `merge.js` sets `generatedAt` to the first burst's start, so
every merge of the same measurement has the same doc id. Write a provisional run after burst 1
and again after bursts 3 and 5 (same doc id, `set` replaces it). If the session ends early, the
dashboard still has the bursts measured so far; the run shows how many.

**Reruns.** A group skipped for time, or with a form factor missing in a burst, simply has fewer
samples; the pooled result is still valid. Only if a group ends with fewer than 15 runs on a form
factor, measure it once more (its own groups file from `fixed.json`, `--burst 6`) and merge again
with that file included — samples are added, never replaced. A wide spread alone is normal for PSI
and is not a reason to rerun. If a command is killed by the shell before `--deadline`, its output
file is never written — rerun that chunk with a lower `--deadline` or smaller `--size`.

`--strategy mobile` / `desktop` still work for a single form factor; keep both form factors in
the same command so they're measured on the same URL.

Two failures are handled automatically, and both are worth reporting because they say
something real about the site:

- **A dead URL** (sitemaps routinely list 404s). Each URL is preflighted with a plain GET first —
  PSI reports a 404 page as a generic HTTP 500, indistinguishable from a transient failure — and
  the script falls back to the group's other candidates rather than losing the group.
- **A redirect to another path.** If a URL lands somewhere else — usually the homepage — the
  measurement is discarded. Without this check the report would silently show the homepage's
  numbers under another group's name. When every candidate in a group redirects, the group is
  skipped: the whole section is effectively gone.

Always tell the user which groups were skipped and why.

### 4b. Field data (automatic)

Lighthouse answers "why is this slow". CrUX answers "is it slow for the people actually using
it" — a 28-day rolling aggregate of real Chrome visits. They disagree often, and when they do
the field data wins for prioritisation.

The PSI response carries the origin's CrUX data, so `audit.js` attaches it to the run as `crux`
(per form factor) and the dashboard shows it — no extra key or step. A site with too little
traffic gets `unavailable` instead, and the dashboard says so. When Google has enough data for an
individual sampled URL, that page's own field numbers are stored on its strategy block as `field`.

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
   `capabilities: {db: {}}` and a title like `Site performance — example.com`, then write the
   config (step 3) and the run into its database.

Run documents must contain `site`, `strategies`, `generated`, `generatedAt`, and `groups`;
`merge.js` emits exactly this, so pass its output unchanged.

### 6. Report back

Give the user the artifact link plus a two or three sentence read of the results in chat: which
group is worst, which metric is dragging the score down, and the single biggest opportunity.
Don't recite every number — the dashboard shows those.

## Unattended runs (scheduled routine)

A routine runs this skill with nobody watching and nobody to answer questions. Rules:

- **Never publish a new artifact.** Publishing asks for approval, which stalls an unattended run.
  Only write to dashboards that already exist. The site list lives in `sites.json` at the
  repository root: `{"sites": [{"site": "...", "origin": "...", "dashboard": "<artifact url>"}]}`.
- **Never republish an existing dashboard page.** Only `write_db`. Data writes don't need the
  page republished.
- **A site without a saved config is skipped**, with a clear note in the summary. Grouping a site
  for the first time needs a human.
- **Always pass `--previous`** with the dashboard's latest run, so a section that fell out of
  the sitemap is still measured on its old page instead of silently disappearing from history.
- **On drift, measure everything `apply-config.js` returns** — including provisional new
  sections and retried missing ones. The flags travel through `audit.js` and `merge.js` into
  the run, and the dashboard labels them. Don't pick different samples yourself.
- **Don't change the config.** Only an interactive session updates it.
- **If `audit.js` exits with code 3** (key rejected or daily PSI quota used up), stop measuring
  every remaining site — they would all fail the same way — and say so at the top of the summary.
- **Prepare every site first** (read config and last run → crawl → group → apply config), then
  **measure in five rounds**: round k runs burst k of every site in turn. After rounds 1, 3 and 5,
  merge and write each site's run (same doc id each time). A session that stops midway still
  leaves every site with the bursts measured so far.
- **End with a summary**: per site, whether it was written and with how many bursts, the median
  and typical range for mobile and desktop per group, any skipped groups with reasons, and any
  drift. That summary is the only place a
  human will see problems.

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
  Wide spreads are normal here; don't rerun a group just because its spread is wide.
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

- `scripts/crawl.js` — sitemap or link crawl → `{site, origin, source, count, urls}`
- `scripts/group.js` — template clustering → `{site, totalUrls, groupCount, groups[]}`
- `scripts/apply-config.js` — applies a saved config to fresh groups; flags new sections as
  provisional and retries vanished ones on the previous run's URL
- `scripts/audit.js` — PageSpeed Insights over samples, both form factors, parallel; attaches
  CrUX origin data (needs `PSI_API_KEY`)
- `scripts/split.js` — splits a groups file into chunks that fit a command's time limit
- `scripts/resolve.js` — fixes each group's URL after burst 1, so later bursts measure the same pages
- `scripts/merge.js` — pools chunks, bursts and reruns into the run document the dashboard reads
- `scripts/stats.js` — median, typical range and sample pooling, shared by audit.js and merge.js
- `scripts/crux.js` — legacy: CrUX via its own API (`CRUX_API_KEY`); PSI already supplies this
- `assets/dashboard.html` — the dashboard page, published once per site
