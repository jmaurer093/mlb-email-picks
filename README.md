# MLB Email Picks — Setup Guide

## What this does
- **12:00 PM, 3:00 PM, 6:00 PM ET** — emails today's picks with EV ratings, confidence scores, and Kelly bet sizes
- **9:00 AM ET every morning** — emails yesterday's win/loss results + your overall record since day one

---

## Step 1: Create a GitHub repo
1. Go to **github.com** → New repository → name it `mlb-email-picks` → Private → Create
2. Upload all files from this folder (keeping folder structure intact)

---

## Step 2: Set up Gmail App Password
Your regular Gmail password won't work — you need an App Password:
1. Go to **myaccount.google.com**
2. Click **Security** → **2-Step Verification** (must be enabled)
3. Scroll down to **App passwords** → Click it
4. Select app: **Mail** → Select device: **Other** → name it "MLB Picks" → Generate
5. Copy the 16-character password shown

---

## Step 3: Add GitHub Secrets
In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add all 5 of these:

| Secret Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `ODDS_API_KEY` | Your API key from the-odds-api.com |
| `GMAIL_USER` | Your Gmail address (e.g. you@gmail.com) |
| `GMAIL_APP_PASSWORD` | The 16-character app password from Step 2 |
| `EMAIL_TO` | Email address to send picks to |

---

## Step 4: Enable GitHub Actions
1. In your repo, click **Actions** tab
2. Click **"I understand my workflows, go ahead and enable them"**
3. Done — it will run automatically on schedule

---

## Email Schedule (Eastern Time)
| Time | Email |
|---|---|
| 9:00 AM | Yesterday's results + overall record |
| 12:00 PM | Noon picks |
| 3:00 PM | Afternoon picks update |
| 6:00 PM | Evening picks (pre-game) |

---

## Test it manually
Go to **Actions** tab → **MLB Value Picks** → **Run workflow** → choose `picks` or `summary` → Run

---

## Change your bankroll
Open `.github/workflows/mlb-picks.yml` and the scripts use $1,000 as the default bankroll for Kelly sizing. To change it, open `scripts/daily-picks.js` and `scripts/morning-summary.js` and update the `bankroll = 1000` value.
