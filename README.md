# site-perf-monitor

Weekly PageSpeed Insights (Lighthouse) measurements for trafft.com, wpdatatables.com, ivyforms.com and wpamelia.com,
written to one dashboard per site.

- `sites.json` — the sites and their dashboard links
- `.claude/skills/site-perf-report/` — the skill that does the measuring
- `ROUTINE.md` — how to set up the Monday routine, and what to check on the first run

Measuring needs a PageSpeed Insights API key, supplied by the routine's environment
(`PSI_API_KEY`, or an API credential with `PSI_KEY_FROM_PROXY=1`) — see `ROUTINE.md`. Never
commit the key.

Grouping decisions for each site (which page stands for which section, what is excluded and
why) live in each dashboard's own database, in `config/groups`, not in this repository. To add
a site, run the skill once from chat so the grouping gets reviewed and saved, then add the site
and its new dashboard link to `sites.json`.
