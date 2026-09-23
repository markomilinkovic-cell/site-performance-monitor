---
name: site-perf-report
description: Measures website performance end to end — crawls a site, groups template pages (blog, docs, tag archives, pagination) so only one representative sample per group is measured, runs Lighthouse over those samples, and publishes the results to a shared dashboard artifact that keeps measurement history. Use this skill whenever the user asks about a site's performance, page speed, Core Web Vitals, Lighthouse scores, LCP/CLS/TBT, why a site is slow, or wants a performance report or audit for any URL — even if they don't name Lighthouse or this skill explicitly. Also use it when they ask to re-measure, re-run, or update an existing performance report.
---

# Site performance report

Crawl a site, measure a representative sample of pages with Lighthouse, publish a dashboard.

Measuring every page of a large site is slow and pointless: a blog with 140 posts renders
140 near-identical pages. This skill groups URLs by template and measures one page per group,
then says so plainly in the report so nobody mistakes a sample for full coverage.

## What the user gets

A shared dashboard artifact with a mobile/desktop toggle showing, per template group: the
Lighthouse performance score (0–100), LCP, FCP, TBT, CLS, Speed Index, TTI, and the top
opportunities — plus CrUX field data when a key is available.

**The dashboard UI is in English.** Group names come from `scripts/group.js`, which labels them
in English too; keep both consistent if you localise either. Every run is appended
to the dashboard's database, so the dashboard also shows history and per-group score deltas
between runs.

## Workflow

Run these in order. **Do not skip step 3** — grouping is the one step where the algorithm can
be wrong, and a bad grouping silently produces a misleading report.

There are two modes. **Interactive** (a person asked in chat) and **unattended** (a scheduled
routine with nobody to ask). They differ only in step 3 and step 5 — see "Unattended runs" below.

### 1. Set up (first run in a session only)

```bash
npm install -g lighthouse --silent
npx -y @puppeteer/browsers install chrome@stable --path "$HOME/.cache/puppeteer"
```

`scripts/audit.js` looks for Chrome under `~/.cache/puppeteer/chrome` and on the PATH, and exits
with a clear message if it can't find one.

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
(`curl -s -o /dev/null -w "%{http_code} %{url_effective}" -L <url>`).

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

### 4. Measure both form factors

Measure mobile and desktop. They are scored separately by Google and routinely differ by 30
points on the same page — a site can look fine on desktop while failing on mobile, and
reporting only one number hides that.

`--runs 3` (the default) measures each page three times and keeps the median, because a single
Lighthouse run is noisy (see "Things worth telling the user"). It triples the time, which is why
the work is split into many short commands. Background jobs don't survive between commands, so
don't reach for `nohup`.

**Budget the commands.** One Lighthouse run takes 30–60s; slow pages take longer. Commands have
a time limit — 300s in claude.ai chat; in Claude Code, the shell tool's timeout. The safe
default is **one group per command on mobile, up to three per command on desktop**. Crowding a
command doesn't just time out: packing three slow mobile groups into one 300s command made
individual attempts fail, which surfaced as an implausible spread (a homepage "ranging" 17–58).

```bash
# 1. one file per group
node scripts/split.js /tmp/groups-final.json --size 1 --prefix /tmp/g-

# 2. mobile, one command per group
node scripts/audit.js /tmp/g-0.json --strategy mobile --out /tmp/m-0.json
node scripts/audit.js /tmp/g-1.json --strategy mobile --out /tmp/m-1.json
# ... one per group

# 3. desktop measures exactly the URLs mobile ended up on
node scripts/resolve.js /tmp/groups-final.json /tmp/m-*.json --out /tmp/resolved.json
node scripts/split.js /tmp/resolved.json --size 3 --prefix /tmp/d-
node scripts/audit.js /tmp/d-0.json --strategy desktop --out /tmp/dout-0.json
# ... one per chunk

# 4. one run document
node scripts/merge.js /tmp/m-*.json /tmp/dout-*.json --out /tmp/run.json
```

`resolve.js` exists because `audit.js` falls back to a candidate URL when a sample fails. Desktop
has to measure the page mobile actually measured, or the dashboard's two numbers describe
different pages.

If a command times out, its output file is never written — rerun that group. Watch each log
line: `only 2/3 runs succeeded`, or a spread much wider than ~10 points, means the measurement
isn't trustworthy yet; rerun that group on its own before writing it to the dashboard.

Two failures are handled automatically, and both are worth reporting because they say
something real about the site:

- **A dead URL** (sitemaps routinely list 404s). The script falls back to the group's other
  candidates rather than losing the group.
- **A redirect to another path.** If a URL lands somewhere else — usually the homepage — the
  measurement is discarded. Without this check the report would silently show the homepage's
  numbers under another group's name. When every candidate in a group redirects, the group is
  skipped: the whole section is effectively gone.

Always tell the user which groups were skipped and why.

### 4b. Field data (optional, needs an API key)

Lighthouse answers "why is this slow". CrUX answers "is it slow for the people actually using
it" — a 28-day rolling aggregate of real Chrome visits. They disagree often, and when they do
the field data wins for prioritisation.

```bash
CRUX_API_KEY=... node scripts/crux.js /tmp/run.json
```

The key is free: enable the Chrome UX Report API in a Google Cloud project and create one
(https://developer.chrome.com/docs/crux/api). Without the key the API returns 403 — skip this
step and say so rather than guessing at field numbers.

A site with too little traffic returns 404 for its origin; the script records that as
unavailable and the dashboard says so. If the response parses to zero metrics, the script saves
the raw body next to the output — read it before trusting anything, because the response shape
has not been verified against a live key.

Don't ask the user to paste their key into chat. Have them set it in the environment for the
command, or run this step themselves.

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
- **Measure one site at a time and finish it** (crawl → group → mobile → desktop → merge →
  write) before starting the next, so a failure late in the run still leaves the earlier sites
  updated.
- **End with a summary**: per site, whether it was written, the median mobile and desktop score
  per group, any skipped groups with reasons, and any drift. That summary is the only place a
  human will see problems.

## Things worth telling the user

- **Lighthouse is a lab measurement, and it is noisy.** The same page measured three times in
  the same minute scored 58, 62, 62 during this skill's development — no change to the site.
  The noise comes almost entirely through TBT (which is 30% of the score): CPU availability on
  the measuring machine fluctuates, JavaScript takes longer to execute, TBT rises, the score
  drops. LCP and CLS are far more stable.
  That is why `--runs` defaults to 3 and the report stores the median plus the observed spread.
  Tell the user to read a change against that spread: if the score moved less than the spread,
  nothing happened. The dashboard already labels such changes "u okviru šuma".
  For a suspected regression, compare the raw metrics rather than the score — a real regression
  shows up as a moved LCP or a genuinely larger TBT, not as a 4-point score wobble.
- **The dashboard is organization-internal.** A page that stores data can't be shared by public
  link, so colleagues need to be in the same organization and signed in.
- **Only the dashboard's owner can add runs to it.** If a colleague runs this skill, they'll get
  their own dashboard rather than adding to someone else's.

## Files

- `scripts/crawl.js` — sitemap or link crawl → `{site, origin, source, count, urls}`
- `scripts/group.js` — template clustering → `{site, totalUrls, groupCount, groups[]}`
- `scripts/apply-config.js` — applies a saved config to fresh groups; flags new sections as
  provisional and retries vanished ones on the previous run's URL
- `scripts/audit.js` — Lighthouse over samples, one or both form factors
- `scripts/split.js` — splits a groups file into chunks that fit a command's time limit
- `scripts/resolve.js` — hands desktop the exact URLs mobile measured
- `scripts/merge.js` — combines per-strategy runs into the run document the dashboard reads
- `scripts/crux.js` — attaches CrUX field data to a run (needs `CRUX_API_KEY`)
- `assets/dashboard.html` — the dashboard page, published once per site
