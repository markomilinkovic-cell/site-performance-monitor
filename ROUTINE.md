# Weekly performance routine — setup

This repository runs the `site-perf-report` skill every Monday and appends a new measurement to
each site's dashboard. Setup takes about ten minutes, then one test run.

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
trafft.com
*.trafft.com
wpdatatables.com
*.wpdatatables.com
ivyforms.com
*.ivyforms.com
wpamelia.com
*.wpamelia.com
```

The sessions only fetch sitemaps and preflight each sample URL directly; the page itself is
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

## 3. Create the routine

- **Name:** Weekly site performance
- **Repository:** the one from step 1
- **Environment:** the one from step 2
- **Connectors:** remove all of them. This routine only needs the built-in artifact tool.
  Anything left in can be used without asking during the run.
- **Trigger:** Schedule → Weekly → Monday. Pick an early hour (e.g. 06:00) so the dashboards
  are fresh when the week starts. Runs may start a few minutes late; that's normal stagger.
- **Prompt:** paste the block below exactly.

```text
Run the weekly performance update for every site listed in sites.json, using the
site-perf-report skill in .claude/skills/site-perf-report/.

This is an unattended run. Nobody is available to answer questions, so follow the skill's
"Unattended runs" section strictly:

- Prepare every site first: read two things from its dashboard's database — the saved grouping
  config (collection "config", doc "groups") and the latest run (collection "runs", ordered by
  generatedAt descending, limit 1). If there is no config, skip that site. Then crawl, group, and
  run apply-config.js with --previous set to that latest run. If apply-config.js reports a site
  structure change, measure every group it returns, including provisional new sections and
  sections retried on the previous run's URL.
- Then measure in five rounds. Round k runs burst k for every site in turn, with audit.js
  --runs 5 --burst k (mobile and desktop together, the default), --deadline 540, a 600000 ms
  shell timeout per command, and chunks from split.js --size 5. After burst 1 of a site, run
  resolve.js on its burst-1 outputs and use that fixed groups file for bursts 2-5, so every burst
  measures the same URLs.
- After rounds 1, 3 and 5, merge each site's burst files so far with merge.js and write the result
  to the dashboard listed in sites.json with write_db, collection "runs", doc_id set to the merged
  run's generatedAt to the second, colons replaced by dashes (for example 2026-09-28T06-00-12Z).
  generatedAt stays the same across the three merges, so each write replaces the previous one.
- If audit.js exits with code 3 (PSI key rejected or quota exhausted), stop measuring, write what
  has been measured so far, and put that at the top of the summary.
- A group skipped for "time budget" or incomplete in one burst just has fewer runs. Only if a
  group ends with fewer than 15 runs on a form factor, measure it once more with --burst 6 and
  merge again. A wide spread alone is normal for PSI and is not a reason to rerun.
- Do not publish or republish any artifact. Do not change any config. Do not modify, commit
  or push anything in the repository.

Finish with a summary: for each site, whether the run was written and with how many bursts, the
median and typical range for mobile and desktop per group, any skipped groups with the reason,
and any site structure drift reported by apply-config.js: which sections are new (measured with
an unreviewed sample) and which vanished (and whether their previous page still worked).
If crawl.js or apply-config.js reports that a sitemap file failed to load (SITEMAP FETCH FAILED),
put that at the top of that site's summary with the sitemap URL and its HTTP status: every page
listed only in that sitemap is missing from the report.
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
3. **How long one session may run.** A full pass is 5 bursts × 5 runs × 2 form factors over 29
   groups: ~1,450 PSI calls, about 5% of one day's free quota. At the measured 10–20 calls a
   minute that is roughly 75–120 minutes, plus ~10 minutes of crawling and preparation. The
   provisional writes after rounds 1 and 3 mean a session cut short still updates every
   dashboard with the bursts it finished.
4. **The shell's command time limit.** The prompt asks for a 600000 ms (10 minute) timeout per
   command and `--deadline 540`. If the transcript shows commands killed before that, lower
   `--size` and `--deadline` in the prompt.

## 5. Test run

On the routine's page, click **Run now**, then open the run and read the transcript. A green
status only means the session didn't crash — not that the work succeeded.

Check that:

- `audit.js` measured without `STOPPED EARLY` (the key worked)
- each site read its config and applied it (look for `apply-config: N groups`)
- each site ended with a successful database write, not a question
- all four dashboards show a new run

If the run stalls on an approval for the database write, stop there: the routine can't do this
job unattended, and the fallback is to keep running updates from chat.

## 6. Expect one step change in the history

Earlier runs were local Lighthouse on whatever machine ran the skill; runs are now measured by
PageSpeed Insights on Google's hardware and carry `source: "psi"`. Scores depend on the measuring
machine, so the first PSI run can shift every score by several points — or more — without the
sites changing. The dashboard labels each run's source, shows runs from other sources dashed in
the history row, and only compares runs of the same source. Treat the first PSI run as the new
baseline and compare forward from there.

`assets/dashboard.html` in this repository is the page currently published on the four
dashboards; the routine never republishes it.
