# site-perf-monitor

Weekly PageSpeed Insights (Lighthouse) measurements for trafft.com, wpdatatables.com, ivyforms.com and wpamelia.com,
written to one dashboard per site.

- **What is measured** comes from the Page Speed Tracker Google Sheet — one tab per site, one row
  per page. Edit the sheet to start or stop tracking a page; the next run picks it up. Author,
  category and tag archives are never measured.
- **Every sitemap URL is health-checked** on each run; pages answering 5xx and sitemap files that
  fail to load are reported at the top of the dashboard and of the routine's summary. Crawled pages
  are not measured.
- `sites.json` — the sheet id, each site's tab name, exclusions and dashboard links
- `.claude/skills/site-perf-report/` — the skill that does the measuring
- `ROUTINE.md` — how to set up the weekly routines (one per site), and what to check on the first run

Measuring needs a PageSpeed Insights API key, supplied by the routine's environment
(`PSI_API_KEY`, or an API credential with `PSI_KEY_FROM_PROXY=1`) — see `ROUTINE.md`. Never
commit the key.

To add a site: add a tab for it to the sheet, run the skill once from chat (it publishes the
dashboard), then add the site, its tab name and the dashboard link to `sites.json` and create its
routine.
