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

**Network access: Full.**
Custom with just the four domains is not enough. Lighthouse loads each page completely,
including analytics, fonts, CDNs, chat widgets and embeds from other domains. If those are
blocked, pages load faster than they do for real visitors and the scores come out better than
the truth, with no error to tell you so.

**Setup script:**

```bash
npm install -g lighthouse
npx -y @puppeteer/browsers install chrome@stable --path "$HOME/.cache/puppeteer"
```

The result is cached, so this doesn't rerun every week.

If the test run (step 5) shows Chrome failing to launch with missing shared libraries, add this
line to the setup script and save:

```bash
sudo apt-get update && sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 libcairo2
```

(On older images the audio package is `libasound2` instead of `libasound2t64`.)

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
  mobile and desktop with --runs 3, resolve, merge, write) before starting the next.
- For each site, first read two things from its dashboard's database: the saved grouping
  config (collection "config", doc "groups") and the latest run (collection "runs", ordered by
  generatedAt descending, limit 1). If there is no config, skip that site. Pass the latest run
  to apply-config.js with --previous.
- If apply-config.js reports a site structure change, measure every group it returns,
  including provisional new sections and sections retried on the previous run's URL.
- Measure mobile one group per command. Desktop may use up to three groups per command.
- If a group reports "only 2/3 runs succeeded" or a spread wider than 10 points, rerun that
  group on its own once before writing.
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

This was built and tested in a claude.ai chat container, not in a routine. Four things can only
be confirmed by a real run:

1. **Whether writing to a dashboard's database asks for approval inside a routine.** The
   routines documentation lists the conditions under which republishing a page proceeds without
   asking, but doesn't say how database writes are treated. If it asks, an unattended run stalls
   at the first site. The prompt deliberately avoids republishing so it stays on the most
   permissive path.
2. **Whether Chrome launches** in the routine's image (see the setup script fallback above).
3. **How long one session may run.** A full pass is about 174 Lighthouse runs across the four
   sites — roughly 1.5 to 2 hours. The documentation doesn't state a session time limit.
4. **Command time limits** in the routine's shell. The skill defaults to small chunks, which is
   safe under any limit seen so far.

## 5. Test run

On the routine's page, click **Run now**, then open the run and read the transcript. A green
status only means the session didn't crash — not that the work succeeded.

Check that:

- the setup step found Chrome and Lighthouse
- each site read its config and applied it (look for `apply-config: N groups`)
- each site ended with a successful database write, not a question
- all four dashboards show a new run

If the run stalls on an approval for the database write, stop there: the routine can't do this
job unattended, and the fallback is to keep running updates from chat.

## 6. Expect one step change in the history

The routine runs on different hardware from the chat sessions that produced the first
measurements. Lighthouse scores depend on the measuring machine's CPU — that's where most of
the noise comes from — so the first routine run can shift every score by several points
without the sites changing at all. Treat the first routine run as the new baseline and compare
forward from there.
