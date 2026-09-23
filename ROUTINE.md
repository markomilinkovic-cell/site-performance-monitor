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

- Process the sites one at a time, finishing each one (crawl, group, apply config, measure
  mobile and desktop with --runs 3, merge, write) before starting the next.
- For each site, first read two things from its dashboard's database: the saved grouping
  config (collection "config", doc "groups") and the latest run (collection "runs", ordered by
  generatedAt descending, limit 1). If there is no config, skip that site. Pass the latest run
  to apply-config.js with --previous.
- If apply-config.js reports a site structure change, measure every group it returns,
  including provisional new sections and sections retried on the previous run's URL.
- Measure with audit.js through PageSpeed Insights: split the groups with split.js --size 5
  and run audit.js once per chunk (mobile and desktop together, the default), with
  --deadline 540, giving each command a 600000 ms shell timeout. Then merge the chunks.
- If audit.js exits with code 3 (PSI key rejected or quota exhausted), stop: don't measure the
  remaining sites, and put that at the top of the summary.
- If a group is skipped for "time budget", comes back incomplete, reports "only 2/3 runs
  succeeded", or shows a spread wider than 10 points, rerun that group on its own once and pass
  the rerun to merge.js after the original chunk.
- Write the finished run to the dashboard listed in sites.json with write_db, collection
  "runs", doc_id set to the run timestamp with colons replaced by dashes.
- Do not publish or republish any artifact. Do not change any config. Do not modify, commit
  or push anything in the repository.

Finish with a summary: for each site, whether the run was written or skipped and why, the
median mobile and desktop score per group, any skipped groups with the reason, and any site
structure drift reported by apply-config.js: which sections are new (measured with an
unreviewed sample) and which vanished (and whether their previous page still worked).
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
3. **How long one session may run.** With PSI a full pass is ~170 API calls, run in parallel —
   roughly 5 to 10 minutes of measuring for all four sites, instead of the 1.5 to 2 hours local
   Lighthouse needed.
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
PageSpeed Insights on Google's hardware and carry `engine: "psi"`. Scores depend on the measuring
machine, so the first PSI run can shift every score by several points — or more — without the
sites changing. The dashboard marks that run with a "Measuring method changed" note, draws no
score deltas across the switch, and puts a divider in the history row. Treat the first PSI run
as the new baseline and compare forward from there.

This needs the updated `assets/dashboard.html` published to each dashboard once, from chat (the
routine never republishes). Until then the old page still reads the new runs fine; it just
shows a misleading delta on the first PSI run.
