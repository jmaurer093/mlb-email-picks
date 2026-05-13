#!/usr/bin/env node
/**
 * Backtesting framework skeleton.
 *
 * Reads `data/season-database.json` and computes:
 *   - Overall record, ROI, P&L
 *   - Hit rate by EV bucket
 *   - Hit rate by confidence score bucket
 *   - Hit rate by sim win prob bucket
 *   - Hit rate by primary pick vs fade pick (when both stored)
 *   - Performance by umpire over/under tendency
 *   - Performance by park factor bucket
 *
 * Usage:
 *   node scripts/backtest.js
 *   node scripts/backtest.js --since 2026-04-01
 *   node scripts/backtest.js --until 2026-05-31
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'season-database.json');

function americanToDecimal(odds) {
  if (!odds) return 1.91; // standard -110 fallback
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

function profitFromBet(result, odds, stake = 100) {
  if (result === 'W') return stake * (americanToDecimal(odds) - 1);
  if (result === 'L') return -stake;
  return 0; // push
}

function bucketLabel(value, edges) {
  for (let i = 0; i < edges.length - 1; i++) {
    if (value >= edges[i] && value < edges[i + 1]) {
      return `${edges[i]}–${edges[i + 1]}`;
    }
  }
  return `≥${edges[edges.length - 1]}`;
}

function summarizeBucket(games, getter, edges, label) {
  const buckets = {};
  for (const g of games) {
    const v = getter(g);
    if (v === null || v === undefined) continue;
    const b = bucketLabel(v, edges);
    if (!buckets[b]) buckets[b] = { n: 0, w: 0, l: 0, p: 0, profit: 0 };
    buckets[b].n++;
    if (g.result === 'W') buckets[b].w++;
    else if (g.result === 'L') buckets[b].l++;
    else if (g.result === 'P') buckets[b].p++;
    buckets[b].profit += profitFromBet(g.result, g.pick_odds);
  }
  console.log(`\n── ${label} ──`);
  console.log(' Bucket       │   N    W-L-P     Hit%     Profit    ROI%');
  for (const [b, s] of Object.entries(buckets).sort()) {
    const hitRate = s.n > 0 ? (s.w / (s.w + s.l) * 100).toFixed(1) : '0.0';
    const roi = s.n > 0 ? (s.profit / (s.n * 100) * 100).toFixed(1) : '0.0';
    console.log(` ${b.padEnd(12)} │ ${String(s.n).padStart(3)}   ${s.w}-${s.l}-${s.p}     ${hitRate.padStart(5)}%   $${s.profit.toFixed(0).padStart(6)}   ${roi.padStart(5)}%`);
  }
}

function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`Database not found at ${DB_FILE}`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf('--since');
  const untilIdx = args.indexOf('--until');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
  const until = untilIdx >= 0 ? args[untilIdx + 1] : null;

  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const allGames = [];
  for (const [date, games] of Object.entries(db.games || {})) {
    if (since && date < since) continue;
    if (until && date > until) continue;
    for (const g of games) {
      if (g.result === 'pending' || g.result === null) continue;
      allGames.push({ ...g, _date: date });
    }
  }
  if (allGames.length === 0) {
    console.log('No settled games in range.');
    return;
  }

  // Overall
  const w = allGames.filter(g => g.result === 'W').length;
  const l = allGames.filter(g => g.result === 'L').length;
  const p = allGames.filter(g => g.result === 'P').length;
  const totalProfit = allGames.reduce((s, g) => s + profitFromBet(g.result, g.pick_odds), 0);
  const hitRate = (w / (w + l) * 100).toFixed(2);
  const roi = (totalProfit / (allGames.length * 100) * 100).toFixed(2);

  console.log(`\n═══ Backtest: ${allGames.length} games${since ? ` since ${since}` : ''}${until ? ` until ${until}` : ''} ═══`);
  console.log(`Overall: ${w}-${l}-${p}   Hit%: ${hitRate}%   P&L: $${totalProfit.toFixed(0)} (on $100 unit)   ROI: ${roi}%`);

  // Segmented
  summarizeBucket(allGames, g => g.ev_pct, [-Infinity, 0, 3, 5, 8, 12], 'By EV %');
  summarizeBucket(allGames, g => g.confidence_score, [0, 40, 55, 65, 75, 85], 'By Confidence Score');
  summarizeBucket(allGames, g => g.sim_home_win_pct, [0, 45, 55, 65, 75, 85], 'By Sim Home Win %');
  summarizeBucket(allGames, g => g.ump_factor, [0, 0.98, 1.0, 1.02, 1.05], 'By Umpire Factor');

  // Pick side
  const homePicks = allGames.filter(g => g.pick === g.home_team);
  const awayPicks = allGames.filter(g => g.pick === g.away_team);
  console.log('\n── By Pick Side ──');
  for (const [label, set] of [['Home picks', homePicks], ['Away picks', awayPicks]]) {
    const sw = set.filter(g => g.result === 'W').length;
    const sl = set.filter(g => g.result === 'L').length;
    const sp = set.reduce((s, g) => s + profitFromBet(g.result, g.pick_odds), 0);
    const sh = sw + sl > 0 ? (sw / (sw + sl) * 100).toFixed(1) : '—';
    console.log(` ${label.padEnd(12)} │ ${set.length} games  ${sw}-${sl}   Hit%: ${sh}%   P&L: $${sp.toFixed(0)}`);
  }

  console.log('\n');
}

main();
