[README.md](https://github.com/user-attachments/files/27728836/README.md)
# MLB Email Picks

Pitching-first MLB betting model with 10M-iteration Monte Carlo simulations, real-time MLB Stats API data, and AI-generated reasoning emailed to you daily.

## What this does

- Pulls real-time data from the MLB Stats API: schedule, probable pitchers, team stats, today's lineups, bullpen usage, umpires, weather, head-to-head batter-vs-pitcher history, injury reports, and travel context.
- Runs a 10M-simulation Monte Carlo (Negative Binomial with mild negative correlation) to project win probabilities, run totals, and prop lines.
- Compares simulation output against current Vegas odds to compute EV and Kelly bet sizes.
- Generates AI-written reasoning for each pick via Anthropic Claude.
- Emails you a clean HTML card with picks, fade alerts, and confidence rankings.
- Tracks every pick in a season database, auto-backs it up before every write, and emails you yesterday's results each morning.

---

## Quick reference: how to run it

Everything is **manual** — nothing runs on a schedule. Each day:

1. Open GitHub → **Actions** tab → **MLB Value Picks** → **Run workflow**
2. Pick `summary` (yesterday's results) or `picks` (today's picks) → green **Run workflow** button
3. Wait ~30 seconds (summary) or 2–3 minutes (picks). Check your email.

You typically run `summary` once in the morning and `picks` once around noon.

---

## Initial setup

### Step 1: Create the GitHub repo
1. github.com → **New repository** → name it `mlb-email-picks` → Private → Create
2. Upload all files from this folder, keeping folder structure intact

### Step 2: Set up Gmail App Password
Your regular Gmail password won't work — you need an App Password:
1. myaccount.google.com → **Security** → **2-Step Verification** (must be enabled)
2. Scroll to **App passwords** → click it
3. Select app: **Mail** → device: **Other** → name it "MLB Picks" → Generate
4. Copy the 16-character password

### Step 3: Add GitHub Secrets
Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `ODDS_API_KEY` | Your API key from the-odds-api.com |
| `GMAIL_USER` | Your Gmail address |
| `GMAIL_APP_PASSWORD` | The 16-character app password from Step 2 |
| `EMAIL_TO` | Email address that receives picks |

### Step 4: Enable GitHub Actions
Repo → **Actions** tab → "I understand my workflows, go ahead and enable them"

That's it. Trigger your first run manually as described above.

---

## How the model works

**Pitching is the primary factor.** Starter quality drives the simulation. Offense, park, weather, and umpire adjust on top.

### Inputs the model uses

- **Starter quality**: season ERA, estimated FIP, WHIP, K/9, BB/9, recent-7-game ERA, rest days, average pitch count from last 3 starts
- **Bullpen state**: team bullpen ERA + last-2-days IP fatigue multiplier + high-leverage usage + closer back-to-back / 3-straight detection
- **Today's lineup**: top-7 batters with order weighting, season OBP/SLG, platoon split vs opposing pitcher hand, head-to-head history regressed toward platoon baseline
- **Team context**: home/away offensive splits, last-14-days form, day-after-night fatigue
- **Defense**: team fielding percentage and BABIP-allowed proxy
- **Travel/series**: timezones crossed since last game, series game number, getaway day
- **Injuries**: cross-reference of team IL list with OPS leaders
- **Park factor**: all 30 MLB venues
- **Weather**: temperature, wind speed and direction (from Open-Meteo)
- **Home plate umpire**: 24-name lookup of known over/under tendency

### Simulation mechanics

For each game, the model computes a run-rate "lambda" for each team incorporating every factor above, then runs 10M simulated games using Negative Binomial sampling. NegBin has fatter tails than Poisson, which better matches real MLB run distributions. Home and away runs are mildly negatively correlated to reflect that pitching dominance often constrains both sides.

Output:
- Home win % and away win % with 95% confidence interval
- Projected total runs (game and F5)
- Over/Under % at the suggested line
- Pitcher strikeout, team HR, and team hits projections

### Pick selection

- Picks the side the simulation favors most
- Computes EV vs Vegas implied probability and Kelly bet size (capped at 25% bankroll)
- Also computes a **fade pick** — if the favored side is -EV, checks whether the opposite side has +EV at its current odds. If so, the email surfaces a yellow warning box with the fade pick, fade EV, and fade Kelly.

---

## Email contents

**Daily picks email** (`picks` mode):
- Top 5 games ranked by confidence score
- Per-card: pick, odds, sim win prob, opponent win %, Kelly bet, full pitching matchup, bullpen state, umpire, weather, AI reasoning
- Fade pick warning on -EV games

**Morning summary email** (`summary` mode):
- Yesterday's results (W/L per pick)
- Season record, total profit, ROI
- Sweeps all pending dates — catches games that were stuck unresolved

---

## File structure

```
mlb-email-picks/
├── .github/workflows/mlb-picks.yml   GitHub Actions workflow (manual trigger)
├── data/
│   ├── season-database.json          season-long pick history + results
│   ├── backups/                      auto-snapshots (daily + hourly retention)
│   └── record.json                   record summary
├── scripts/
│   ├── daily-picks.js                main picks engine + email
│   ├── morning-summary.js            yesterday-results email + result sweep
│   ├── database.js                   atomic DB writes + auto-backup
│   ├── backtest.js                   segmented backtest analysis
│   ├── player-props.js               pitcher Ks / batter prop simulator
│   └── restore-backup.js             restore from snapshot
├── dashboard.html                    season tracking dashboard (Netlify)
├── package.json
└── README.md
```

---

## Backups & recovery

Three layers of redundancy protect your season database:

1. **Auto-snapshots** in `data/backups/` — runs before every database write. Daily snapshots (30-day retention) + hourly snapshots (10-snapshot retention). Auto-prunes old files.
2. **Atomic writes** — database saves go to a temp file first, then atomically rename. Crashes mid-write can't corrupt the real file.
3. **GitHub Actions artifacts** — every workflow run uploads the entire `data/` folder as a 90-day-retained artifact stored on GitHub's servers, separate from your repo history.

### Restore from a backup

From your laptop terminal in the repo folder:

```bash
node scripts/restore-backup.js              # list available snapshots
node scripts/restore-backup.js latest       # restore most recent
node scripts/restore-backup.js daily-2026-04-20   # restore specific date
node scripts/restore-backup.js --dry-run latest   # preview without restoring
```

Restore automatically creates a `pre-restore-*` safety backup first, so the restore itself is reversible.

---

## Backtesting

After a few weeks of data, run:

```bash
node scripts/backtest.js                    # all settled games
node scripts/backtest.js --since 2026-04-01
node scripts/backtest.js --until 2026-05-31
```

Outputs hit rate, P&L, and ROI segmented by:
- EV bucket
- Confidence score bucket
- Simulated win-probability bucket
- Umpire factor bucket
- Pick side (home vs away)

---

## Customization

**Change your bankroll** (default $1000 for Kelly sizing):
- Edit the `bankroll = 1000` value in `scripts/daily-picks.js`

**Change simulation parameters**:
- Edit the `opts` in `analyzeGame()` to switch distribution (`'negbin'` or `'poisson'`), change dispersion `k`, or adjust home/away correlation

**Change top-N picks emailed** (default 5):
- Edit `.slice(0, 5)` in `buildPicksEmail` in `scripts/daily-picks.js`

---

## What's intentionally missing (and why)

- **Statcast / OAA / framing runs**: FanGraphs-proprietary, not in the free MLB API. Would need scraping. Defense factor uses a fielding-pct + BABIP proxy instead.
- **xFIP / SIERA**: same reason. Model computes its own FIP estimate from K/BB/HR rates.
- **Live odds during the day**: model picks once when you run it. Re-running later would require new Odds API calls and isn't part of the manual workflow by design.
