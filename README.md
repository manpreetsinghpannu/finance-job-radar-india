# Finance Job Radar (India)

Hourly scan for newly posted **junior finance roles anywhere in India**: FP&A,
financial analyst, credit and risk, equity research, investment banking,
valuations, fund accounting, consulting. New roles go to your phone through
[ntfy](https://ntfy.sh) and are listed on [JOBS.md](JOBS.md), grouped by the CV
they fit best, with the top 2 picks for each CV.

The sister radar for the UK is `finance-job-radar`. Both use the zero-cost
[career-ops](https://github.com/career-ops-hq/career-ops) scanner (pinned in
`.github/workflows/scan.yml`).

## What's scanned

| Source | What it covers |
|---|---|
| `portals.yml` | ~70 global banks, asset managers, trading firms, consultancies and GCCs with India offices (JPMorgan, Morgan Stanley, Citi, Barclays, BlackRock, Houlihan Lokey, S&P, Moody's, MSCI, LSEG, Accenture, EY…). Only India-based roles get through |
| `companies.yml` | ~150 more employers: Indian banks, NBFCs, AMCs, brokers, IB boutiques, PE funds, rating agencies, KPOs, trading firms, corporates. The weekly discovery job finds their hiring boards and adds them to `portals.yml` |
| `companies_startups.yaml` | Indian startups and scale-ups on Greenhouse, Lever, Ashby or Workable (fintechs, brokers, lenders, consumer tech) |
| `boards.yml` | LinkedIn public job search, location India, last 24 hours |

Not covered: Naukri, foundit, iimjobs, Instahyre and Indeed India block automated
access or forbid it, and many Indian firms use Darwinbox/Keka portals that can't
be read. Set up email alerts on those directly.

## Alerts

- **Every hour, only when something new appears:** scan time, count per CV,
  and every new role under the CV it fits. Startup roles are tagged `[startup/SME]`.
- **Every morning (first scan after 08:00 UK):** the top 2 open roles for each CV.
- A firm's or board's first scan records what's already open without alerting.

## Setup

1. Repo secret `NTFY_TOPIC` = your India topic; subscribe to it in the ntfy app.
2. cron-job.org job POSTing to
   `https://api.github.com/repos/<you>/finance-job-radar-india/actions/workflows/scan.yml/dispatches`
   with body `{"ref":"main"}` at minute 30 of every hour (same headers as the UK job).
   GitHub's own schedule (:07 and :37) is the backup.

## Adding firms

- **Startups:** see the instructions at the top of `companies_startups.yaml`,
  then run **Check startup list** in the Actions tab.
- **Bigger employers:** add a line to `companies.yml`; the Monday discovery job
  finds the board. Or add a board directly to `portals.yml` (`name` + `careers_url`).

## Tuning

Title keywords, seniority and the India location list are in `portals.yml`.
Search terms for LinkedIn are in `boards.yml`. CV keyword profiles and ranking
are in `profiles.yml` (Mumbai roles get a small boost).
