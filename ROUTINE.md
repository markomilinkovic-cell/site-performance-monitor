# Weekly performance routine — setup

This repository runs the `site-perf-report` skill once a week per site and appends a new
measurement to that site's dashboard. The pages to measure are read from the **Page Speed
Tracker** Google Sheet at the start of every run, so changing what is tracked means editing the
sheet — nothing in this repository or in the routine prompt.

There is **one routine per site** (four routines, Monday to Thursday). With every tracked page
measured on its own instead of one sample per template, a site is 17–27 pages, and one site
alone is ~1–2 hours of PSI calls; all four in one session would be 5–8 hours.

## 0. Share the sheet

The routine reads the sheet without signing in to Google, through its CSV endpoint. That only
works when the sheet is shared as **Anyone with the link → Viewer** (Share → General access).
The sheet holds only public URLs of public sites, so this exposes nothing that isn't already on
the sites. If sharing is ever turned off, every run stops with `SHEET UNREADABLE` at the top of
its summary instead of measuring an outdated list.

Keep the layout: one tab per site, named as in `sites.json` (`sheetTab`), with a header row
containing `Website`, `Page Type` and `URL`. Adding or removing rows is all that's needed;
renaming a tab needs the same change in `sites.json`. Author, category and tag archives are never
measured even if listed (`excludePaths` in `sites.json`).

## 1. Push this folder to GitHub

Create a private repository (for example `site-perf-monitor`) and push this folder as is.
The skill must stay at `.claude/skills/site-perf-report/` — that's where Claude Code finds
project skills in a cloned repository.

## 2. Create the environment

At claude.ai/code/routines → New routine → environment selector → create a new environment
(don't edit Default; other routines may rely on it).

**Network access: Custom**, with **Also include default list of common package managers**
checked (it already covers `*.googleapis.com`, where PSI lives), and these allowed domains:

```text
docs.google.com
trafft.com
*.trafft.com
wpdatatables.com
*.wpdatatables.com
ivyforms.com
*.ivyforms.com
wpamelia.com
*.wpamelia.com
```

`docs.google.com` is for reading the sheet. The sessions also fetch sitemaps, request every
sitemap URL once for the health check, and preflight each tracked URL directly; the page itself is
loaded by PageSpeed Insights on Google's machines, with all its third-party scripts, whatever
this allowlist says. (Under the old local-Lighthouse setup, blocking third parties made scores
look better than the truth; that no longer applies.) **Full** also works if you'd rather not
maintain the list.

**Setup script:** leave it empty. Nothing needs installing — no Chrome, no Lighthouse; Node 22
is pre-installed.

**The PSI API key** — pick the option your plan allows:

- **Pro or Max plan: store it as an API credential** (the session never sees the key). Save the
  environment first, reopen it for editing, and under **API credentials** → **Add credential**:
  - Name: `PageSpeed Insights`
  - Allowed websites: `www.googleapis.com`
  - Custom headers: name `X-Goog-Api-Key`, clear the `Bearer` prefix, value = the key

  Then add this line under **Environment variables** so the skill knows not to expect the key
  itself:

  ```text
  PSI_KEY_FROM_PROXY=1
  ```

- **Team or Enterprise plan** (API credentials aren't available there yet): add the key under
  **Environment variables** of this personal environment, and don't share the environment with
  the organization — everyone who can use an environment can read its variables:

  ```text
  PSI_API_KEY=your-key
  ```

Either way, never commit the key to this repository. In Google Cloud Console, restrict the key
to the **PageSpeed Insights API** only, so a leaked key can't be used for anything else.

## 3. Create the routines

Create four routines with the same settings, differing only in name, day and the site in the
prompt:

| Routine | Trigger | Site in prompt |
|---|---|---|
| Weekly performance — trafft.com | Weekly, Monday 07:00 | `trafft.com` |
| Weekly performance — wpdatatables.com | Weekly, Tuesday 07:00 | `wpdatatables.com` |
| Weekly performance — ivyforms.com | Weekly, Wednesday 07:00 | `ivyforms.com` |
| Weekly performance — wpamelia.com | Weekly, Thursday 07:00 | `wpamelia.com` |

One site a day keeps two sessions from calling PSI at the same time (above ~10 parallel calls PSI
starts failing) and keeps each session to 1–2 hours.

- **Repository:** the one from step 1
- **Environment:** the one from step 2
- **Connectors:** the built-in artifact tool, the Slack connector, and the Jira connector.
  Remove every other connector. Anything left in can be used without asking during the run, so
  the prompt tells the session to search Jira and to post to one Slack channel, and not to
  create Jira issues or message any other channel. The sheet is read over plain HTTPS, not
  through the Google Drive connector. Jira and Slack are reached through their connectors, not
  through the network allowlist.
- **Prompt:** paste the block below. Replace `SITE`, `ORIGIN` and `DASHBOARD` from `sites.json`
  (for trafft.com: `https://trafft.com` and `https://claude.ai/artifact/Kjs1P2ewU7wjqFudqxtH1J`).

```text
Run the weekly performance update for SITE, using the site-perf-report skill in
.claude/skills/site-perf-report/ and its entry in sites.json.

This is an unattended run. Nobody is available to answer questions, so follow the skill's
"Unattended runs" section strictly. Run every command from the repository root; S below means
.claude/skills/site-perf-report/scripts.

- Prepare first:
  1. node S/pages.js --site SITE --sites sites.json --out /tmp/pages.json
     This reads the pages to measure from the Page Speed Tracker sheet. It is the only page list;
     don't add, drop or substitute pages. If it exits 4 (sheet unreadable) or 5 (no pages), do not
     measure; still do steps 2-3, write nothing to the dashboard, and put the error at the top of
     the summary and of the Slack message.
  2. node S/crawl.js ORIGIN --out /tmp/urls.json
  3. node S/health.js /tmp/urls.json --pages /tmp/pages.json --deadline 540 --out /tmp/health.json
     (600000 ms shell timeout). The crawl is used only for this check.
  4. node S/split.js /tmp/pages.json --size 5 --prefix /tmp/g-
- Before measuring, read the dashboard's latest run (read_db, collection "runs", query ordered by
  generatedAt descending, limit 1) and save it as /tmp/previous-run.json. It is used only for the
  comparison in the Slack message. If there is none, there is nothing to compare.
- Then measure in five rounds. Round k runs node S/audit.js --runs 5 --burst k --deadline 540 on
  every chunk in turn (mobile and desktop together, the default), with a 600000 ms shell timeout
  per command. Every round uses the same chunk files.
- After rounds 1 and 3, merge every burst file so far with
  node S/merge.js ... --health /tmp/health.json --out /tmp/run.json, and write /tmp/run.json to
  the SITE dashboard listed in sites.json (DASHBOARD) with write_db, collection "runs", doc_id
  set to the merged run's generatedAt to the second, colons replaced by dashes (for example
  2026-10-05T07-00-12Z). Do not run the Jira check on these provisional writes.
- After round 5, merge the same way, then run the Jira check below, then write the stamped
  /tmp/run.json with the same doc_id. generatedAt stays the same across the three merges, so
  each write replaces the previous one.
- If audit.js exits with code 3 (PSI key rejected or quota exhausted), stop measuring, run the
  Jira check, write what has been measured so far, and put that at the top of the summary.
- Jira check, once, before that last write (and also when you did not measure but the health
  check ran). Follow "Serious problems and Jira" in the skill:
  1. node S/issues.js --health /tmp/health.json --run /tmp/run.json --out /tmp/issues.json
     Omit --run when there is no measurement. This lists only a URL that answered 5xx twice and
     a sitemap that failed to load. A score drop is not a task; report it in the summary and the
     Slack message only. The script does not call Jira.
  2. For each problem, search project WEB with the Jira connector using that problem's jql
     (unresolved issues only). Do not create or edit issues. If one comes back, set key and
     browseUrl on that object. When every search has been done, set "checked" to true in
     /tmp/issues.json. If the connector is unavailable or a search fails, leave checked false
     and say Jira was not checked; do not claim there is no task.
  3. When a run file exists and checked is true: node S/issues.js --stamp /tmp/run.json --issues /tmp/issues.json
     then write_db that file. If stamp exits 2, write the unstamped run.
- A page skipped for "time budget" or incomplete in one burst just has fewer runs. Only if a page
  ends with fewer than 15 runs on a form factor, measure it once more with --burst 6 and merge
  again. A wide spread alone is normal for PSI and is not a reason to rerun.
- Do not publish or republish any artifact. Do not modify the sheet, sites.json, or anything else
  in the repository; do not commit or push.

Finish with a summary, in this order:
1. Health check: every URL that answered 5xx twice (say which are tracked pages), any sitemap file
   that failed to load (SITEMAP FETCH FAILED, with its URL and status — the pages listed only there
   were not checked), and the count of 404s.
2. Sheet: rows pages.js skipped and why (wrong host, duplicate, excluded archive, bad URL).
3. Measurement: whether the run was written and with how many bursts, the median and typical
   range for mobile and desktop per page, and any skipped pages with the reason (a 404 or
   redirect means the sheet row points at an old URL).
4. Jira: every 5xx URL and failed sitemap from issues.js. If an open WEB issue was found, its key
   and link. If none was found, say that no Jira task exists and that one should be created on
   https://tmsplugins.atlassian.net/jira/software/projects/WEB/boards/30, and include the
   suggested title. Do not create it. If Jira could not be searched, say that instead of claiming
   there is no task. If there were no such problems, say so. Score drops are not listed here.

Finally, after the last write to the dashboard (or after deciding not to measure), send one
message to the Slack channel C0C4A4B5SA1 (#melograno-website-performance) using the Slack
connector. Send it only to that channel; if sending fails, note it in the run summary, do not
fail the run because of it, and do not try other channels. Content, using Slack formatting
(*bold*, bullet points with •) and no tables:
- First line: *SITE* and a one-line overall status (measured / partially measured with
  N of 5 bursts / not measured, and why).
- The dashboard link: DASHBOARD
- Health check: if any URL answered 5xx or a sitemap failed to load, list those URLs first, marked
  clearly as a problem. Otherwise one line saying no server errors, with the number of URLs checked.
- Scores: the median across all measured pages of each page's median score, for mobile and for
  desktop, and the three lowest-scoring pages on mobile with their scores.
- Change from the previous run: compare only pages with the same name that exist in both
  /tmp/previous-run.json and this run, and only if both runs have source "psi". Call a change a
  drop or an improvement only when the two runs' typical ranges for that page don't overlap;
  otherwise it is within noise. List every page that dropped, clearly highlighted, with old and new
  median. If no pages match (for example the first run after switching to the sheet), say
  "first run with the sheet page list, no comparison".
- Jira, one bullet per 5xx URL and failed sitemap: the issue key and link when an open WEB task
  exists, or *No Jira task* plus the suggested title and the WEB board link when it does not.
  Do not create the task. If none of those problems were found, one line saying so. A score drop
  stays in the change list above and does not get a task.
- Sheet rows that were skipped, and pages that were skipped during measurement, each with the
  reason.
```

## 4. Before relying on it: what hasn't been verified

The skill was built and tested in a claude.ai chat container, not in a routine. These can only
be confirmed by a real run:

1. **Whether writing to a dashboard's database asks for approval inside a routine.** The
   routines documentation lists the conditions under which republishing a page proceeds without
   asking, but doesn't say how database writes are treated. If it asks, an unattended run stalls
   at the first site. The prompt deliberately avoids republishing so it stays on the most
   permissive path.
2. **Whether the PSI key reaches PSI.** With the API credential option, the first call answering
   "daily quota exhausted" means the proxy didn't attach the key (a keyless call lands on
   Google's shared quota, which is always used up) — check the credential's host and header.
3. **How long one session may run.** One site is 5 bursts × 5 runs × 2 form factors over its
   17–27 pages: 850–1,350 PSI calls (about 5% of one day's free quota). At the measured 10–20
   calls a minute that is roughly 45–135 minutes, plus a few minutes for the sheet, the crawl and
   the health check. The provisional writes after rounds 1 and 3 mean a session cut short still
   updates the dashboard with the bursts it finished.
5. **Whether the sheet is reachable from the environment.** The first command of the run,
   `pages.js`, answers `SHEET UNREADABLE` if `docs.google.com` isn't allowed or the sheet isn't
   shared by link.
4. **The shell's command time limit.** The prompt asks for a 600000 ms (10 minute) timeout per
   command and `--deadline 540`. If the transcript shows commands killed before that, lower
   `--size` and `--deadline` in the prompt.

## 5. Test run

On the routine's page, click **Run now**, then open the run and read the transcript. A green
status only means the session didn't crash — not that the work succeeded.

Check that:

- `pages.js` printed `N pages for SITE from sheet …` with the number of rows in that tab
- `health.js` printed its summary line (and nothing was cut off by the deadline)
- `audit.js` measured without `STOPPED EARLY` (the key worked)
- the run ended with a successful database write, not a question
- the dashboard shows a new run with the sheet's pages and a "Health check" line at the top
- each 5xx URL and failed sitemap in the summary names a WEB issue, or says none exists and a task should be created. A score drop is only mentioned, with no task

Run one routine first (ivyforms.com is the quickest to check), then enable the other three.

If the run stalls on an approval for the database write, stop there: the routine can't do this
job unattended, and the fallback is to keep running updates from chat.

## 6. Expect a step change in the history

**The first sheet-based run is a new baseline.** Earlier runs measured one sample per template
group ("Blog", "Documentation" …); now every sheet row is its own entry ("Blog Post ·
nps-survey-questions"). Entries are matched across runs by name, so old groups simply stop and
new pages start without a delta, and the overall score in the history row is taken over a
different set of pages. Compare forward from the first sheet-based run.

The same holds for the switch to PSI:

Earlier runs were local Lighthouse on whatever machine ran the skill; runs are now measured by
PageSpeed Insights on Google's hardware and carry `source: "psi"`. Scores depend on the measuring
machine, so the first PSI run can shift every score by several points — or more — without the
sites changing. The dashboard labels each run's source, shows runs from other sources dashed in
the history row, and only compares runs of the same source. Treat the first PSI run as the new
baseline and compare forward from there.

`assets/dashboard.html` in this repository is the page currently published on the four
dashboards; the routine never republishes it. The yellow and red Jira lines are drawn by that
page from `issues` on the run. After this change, republish each site's dashboard once from
chat, or the colors stay on the old page even when the run data has the issue keys.
