const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./database');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${url.split('?')[0]} — ${data.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function dec(o) { return o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1; }
function fmtOdds(o) { return o > 0 ? `+${o}` : `${o}`; }
function fmtProfit(p) { return `${p >= 0 ? '+' : ''}$${Math.abs(p).toFixed(0)}`; }
function pColor(p) { return p > 0 ? '#16a34a' : p < 0 ? '#dc2626' : '#6b7280'; }
function resultColor(r) {
  return r === 'W' ? '#16a34a' : r === 'L' ? '#dc2626' : r === 'P' ? '#6b7280' : '#ca8a04';
}
function resultLabel(r) {
  return r === 'W' ? 'WIN' : r === 'L' ? 'LOSS' : r === 'P' ? 'PUSH' : 'PENDING';
}
function resultBg(r) {
  return r === 'W' ? '#f0fdf4' : r === 'L' ? '#fef2f2' : r === 'P' ? '#f9fafb' : '#fffbeb';
}

function yesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

async function fetchYesterdayScores(dateStr) {
  const ymd = dateStr.replace(/-/g, '');
  const scores = [];

  try {
    // Try MLB Stats API first
    const data = await httpsGet(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=linescore,team`
    );
    for (const dateEntry of (data.dates || [])) {
      for (const game of (dateEntry.games || [])) {
        if (game.status?.abstractGameState !== 'Final') continue;
        scores.push({
          home: game.teams?.home?.team?.name,
          away: game.teams?.away?.team?.name,
          homeScore: game.teams?.home?.score,
          awayScore: game.teams?.away?.score,
          innings: game.linescore?.currentInning || 9,
          status: game.status?.detailedState,
        });
      }
    }
    console.log(`MLB API: ${scores.length} final scores for ${dateStr}`);
  } catch(e) {
    console.log('MLB API score fetch failed:', e.message);
    // Fallback to ESPN
    try {
      const espn = await httpsGet(
        `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${ymd}`
      );
      for (const event of (espn.events || [])) {
        const comp = event.competitions?.[0];
        if (!comp?.status?.type?.completed) continue;
        const home = comp.competitors?.find(c => c.homeAway === 'home');
        const away = comp.competitors?.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        scores.push({
          home: home.team?.displayName,
          away: away.team?.displayName,
          homeScore: parseInt(home.score || '0'),
          awayScore: parseInt(away.score || '0'),
        });
      }
      console.log(`ESPN fallback: ${scores.length} scores`);
    } catch(e2) {
      console.log('ESPN fallback also failed:', e2.message);
    }
  }

  return scores;
}

function buildDayResultsSection(date, games) {
  if (!games.length) return '<p style="color:#6b7280;font-size:13px">No games logged for this date.</p>';

  const wins = games.filter(g => g.result === 'W').length;
  const losses = games.filter(g => g.result === 'L').length;
  const pushes = games.filter(g => g.result === 'P').length;
  const pending = games.filter(g => g.result === 'pending').length;
  const bankroll = 1000;

  const dayProfit = games.reduce((acc, g) => {
    const bet = (g.kelly_pct / 100) * bankroll;
    if (g.result === 'W') return acc + (dec(g.pick_odds) - 1) * bet;
    if (g.result === 'L') return acc - bet;
    return acc;
  }, 0);

  const rows = games.map(g => {
    const bet = ((g.kelly_pct / 100) * bankroll).toFixed(0);
    const pnl = g.result === 'W'
      ? `+$${((dec(g.pick_odds) - 1) * (g.kelly_pct / 100) * bankroll).toFixed(0)}`
      : g.result === 'L'
        ? `-$${((g.kelly_pct / 100) * bankroll).toFixed(0)}`
        : g.result === 'P' ? '$0' : '—';
    const pnlColor = g.result === 'W' ? '#16a34a' : g.result === 'L' ? '#dc2626' : '#6b7280';

    return `
<tr style="background:${resultBg(g.result)};border-bottom:1px solid #f3f4f6">
  <td style="padding:10px 12px">
    <div style="font-size:13px;font-weight:600;color:#111827">${g.away_team} @ ${g.home_team}</div>
    <div style="font-size:11px;color:#6b7280;margin-top:2px">${g.game_time || ''} · ${g.away_pitcher || 'TBD'} vs ${g.home_pitcher || 'TBD'}</div>
  </td>
  <td style="padding:10px 12px;text-align:center">
    <div style="font-size:13px;font-weight:600;color:#111827">${g.pick}</div>
    <div style="font-size:11px;color:#6b7280">${fmtOdds(g.pick_odds)}</div>
  </td>
  <td style="padding:10px 12px;text-align:center">
    <div style="font-size:12px;font-weight:600;color:#1d4ed8">${g.pick === g.home_team ? g.sim_home_win_pct : g.sim_away_win_pct}%</div>
    <div style="font-size:10px;color:#6b7280">CI: ${g.ci_low}–${g.ci_high}%</div>
  </td>
  <td style="padding:10px 12px;text-align:center">
    <div style="font-size:12px;color:${g.ev_pct > 0 ? '#16a34a' : '#dc2626'};font-weight:600">${g.ev_pct > 0 ? '+' : ''}${g.ev_pct}%</div>
  </td>
  <td style="padding:10px 12px;text-align:center">
    <div style="font-size:12px;color:#374151">$${bet}</div>
  </td>
  <td style="padding:10px 12px;text-align:center">
    <div style="font-size:11px;color:#6b7280">${g.final_result_str || '—'}</div>
  </td>
  <td style="padding:10px 12px;text-align:center">
    <span style="background:${resultColor(g.result)}18;border:1px solid ${resultColor(g.result)}44;color:${resultColor(g.result)};border-radius:4px;padding:3px 8px;font-size:11px;font-weight:700">${resultLabel(g.result)}</span>
    <div style="font-size:11px;color:${pnlColor};font-weight:600;margin-top:3px">${pnl}</div>
  </td>
</tr>`;
  }).join('');

  const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return `
<div style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;margin-bottom:24px;overflow:hidden">
  <div style="background:#1e3a5f;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
    <div>
      <div style="color:#fff;font-size:15px;font-weight:700">${dateLabel}</div>
      <div style="color:#93c5fd;font-size:12px;margin-top:2px">${games.length} picks · ${wins}W ${losses}L${pushes > 0 ? ` ${pushes}P` : ''}${pending > 0 ? ` ${pending} pending` : ''}</div>
    </div>
    <div style="background:${dayProfit >= 0 ? '#16a34a' : '#dc2626'};border-radius:8px;padding:8px 16px;text-align:center">
      <div style="color:#fff;font-size:18px;font-weight:700">${fmtProfit(dayProfit)}</div>
      <div style="color:${dayProfit >= 0 ? '#bbf7d0' : '#fca5a5'};font-size:10px;text-transform:uppercase;letter-spacing:0.5px">Day P&L</div>
    </div>
  </div>
  <div style="overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:13px;min-width:600px">
      <thead>
        <tr style="background:#f8fafc;border-bottom:2px solid #e5e7eb">
          <th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Matchup</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Pick</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Sim Prob / CI</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">EV %</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Bet</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Final Score</th>
          <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Result / P&L</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;
}

function buildSeasonTable(allGames, stats) {
  const dates = Object.keys(allGames).sort();
  const bankroll = 1000;

  const dateRows = dates.map(date => {
    const games = allGames[date];
    const w = games.filter(g => g.result === 'W').length;
    const l = games.filter(g => g.result === 'L').length;
    const p = games.filter(g => g.result === 'P').length;
    const pend = games.filter(g => g.result === 'pending').length;
    const dayProfit = games.reduce((acc, g) => {
      const bet = (g.kelly_pct / 100) * bankroll;
      if (g.result === 'W') return acc + (dec(g.pick_odds) - 1) * bet;
      if (g.result === 'L') return acc - bet;
      return acc;
    }, 0);
    const dateLabel = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const pct = w + l > 0 ? ((w / (w + l)) * 100).toFixed(0) + '%' : '—';

    return `
<tr style="border-bottom:1px solid #f3f4f6">
  <td style="padding:8px 12px;font-size:13px;color:#374151;font-weight:500">${dateLabel}</td>
  <td style="padding:8px 12px;text-align:center;font-size:13px"><span style="color:#16a34a;font-weight:600">${w}W</span> <span style="color:#dc2626;font-weight:600">${l}L</span>${p > 0 ? ` <span style="color:#6b7280">${p}P</span>` : ''}${pend > 0 ? ` <span style="color:#ca8a04">${pend}⏳</span>` : ''}</td>
  <td style="padding:8px 12px;text-align:center;font-size:13px;color:#374151">${pct}</td>
  <td style="padding:8px 12px;text-align:center;font-size:13px;font-weight:600;color:${pColor(dayProfit)}">${fmtProfit(dayProfit)}</td>
</tr>`;
  }).join('');

  // Running totals row
  let runningW = 0, runningL = 0, runningProfit = 0;
  const runningRows = dates.map(date => {
    const games = allGames[date];
    const w = games.filter(g => g.result === 'W').length;
    const l = games.filter(g => g.result === 'L').length;
    const dayProfit = games.reduce((acc, g) => {
      const bet = (g.kelly_pct / 100) * bankroll;
      if (g.result === 'W') return acc + (dec(g.pick_odds) - 1) * bet;
      if (g.result === 'L') return acc - bet;
      return acc;
    }, 0);
    runningW += w; runningL += l; runningProfit += dayProfit;
    return null;
  });

  return `
<div style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;margin-bottom:24px;overflow:hidden">
  <div style="background:#111827;padding:16px 20px">
    <div style="color:#fff;font-size:15px;font-weight:700">2026 Season Tracker</div>
    <div style="color:#9ca3af;font-size:12px;margin-top:2px">Every pick since March 30, 2026</div>
  </div>
  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr style="background:#f8fafc;border-bottom:2px solid #e5e7eb">
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Date</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Record</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Win %</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">P&L</th>
      </tr>
    </thead>
    <tbody>
      ${dateRows}
      <tr style="background:#f8fafc;border-top:2px solid #e5e7eb;font-weight:700">
        <td style="padding:10px 12px;font-size:13px;color:#111827">SEASON TOTAL</td>
        <td style="padding:10px 12px;text-align:center;font-size:13px"><span style="color:#16a34a">${stats.wins}W</span> <span style="color:#dc2626">${stats.losses}L</span>${stats.pushes > 0 ? ` <span style="color:#6b7280">${stats.pushes}P</span>` : ''}</td>
        <td style="padding:10px 12px;text-align:center;font-size:13px;color:#111827">${stats.win_pct || 0}%</td>
        <td style="padding:10px 12px;text-align:center;font-size:14px;font-weight:700;color:${pColor(stats.profit)}">${fmtProfit(stats.profit)}</td>
      </tr>
    </tbody>
  </table>
</div>`;
}

function buildSummaryEmail(yesterday, yesterdayGames, allGames, stats) {
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  const yesterdayLabel = new Date(yesterday + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const yw = yesterdayGames.filter(g => g.result === 'W').length;
  const yl = yesterdayGames.filter(g => g.result === 'L').length;
  const yp = yesterdayGames.filter(g => g.result === 'P').length;
  const bankroll = 1000;
  const yProfit = yesterdayGames.reduce((acc, g) => {
    const bet = (g.kelly_pct / 100) * bankroll;
    if (g.result === 'W') return acc + (dec(g.pick_odds) - 1) * bet;
    if (g.result === 'L') return acc - bet;
    return acc;
  }, 0);

  const dayResultsSection = buildDayResultsSection(yesterday, yesterdayGames);
  const seasonTableSection = buildSeasonTable(allGames, stats);

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:20px">
<div style="max-width:760px;margin:0 auto">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1e3a5f,#1d4ed8);border-radius:14px;padding:28px;margin-bottom:20px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">📊</div>
    <div style="color:#fff;font-size:22px;font-weight:700">Morning Results</div>
    <div style="color:#bfdbfe;font-size:13px;margin-top:6px">${todayLabel}</div>
    <div style="color:#93c5fd;font-size:11px;margin-top:4px">Powered by 10M Monte Carlo · MLB Stats API · The Odds API</div>
  </div>

  <!-- Yesterday summary stat cards -->
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px">
    ${[
      ['Yesterday W', yw, '#16a34a'],
      ['Yesterday L', yl, '#dc2626'],
      ['Pushes', yp, '#6b7280'],
      ['Day P&L', fmtProfit(yProfit), pColor(yProfit)],
      ['Season P&L', fmtProfit(stats.profit), pColor(stats.profit)],
    ].map(([l, v, c]) => `
    <div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
      <div style="font-size:20px;font-weight:700;color:${c}">${v}</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-top:3px">${l}</div>
    </div>`).join('')}
  </div>

  <!-- Season stats -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px">
    ${[
      ['Season Record', stats.record || '0-0', '#111827'],
      ['Win Rate', `${stats.win_pct || 0}%`, stats.win_pct >= 55 ? '#16a34a' : stats.win_pct >= 50 ? '#ca8a04' : '#dc2626'],
      ['Total Wagered', `$${(stats.total_wagered || 0).toFixed(0)}`, '#374151'],
      ['ROI', `${stats.roi >= 0 ? '+' : ''}${stats.roi || 0}%`, pColor(stats.roi)],
    ].map(([l, v, c]) => `
    <div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
      <div style="font-size:18px;font-weight:700;color:${c}">${v}</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-top:3px">${l}</div>
    </div>`).join('')}
  </div>

  <!-- Yesterday's game-by-game results -->
  <div style="font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">
    📅 ${yesterdayLabel} — Game by Game
  </div>
  ${dayResultsSection}

  <!-- Full season table -->
  <div style="font-size:13px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">
    🏆 Full Season Log
  </div>
  ${seasonTableSection}

  <div style="text-align:center;color:#9ca3af;font-size:11px;padding:16px;line-height:1.8">
    Picks powered by 10M Monte Carlo simulations · MLB Stats API · Kelly criterion sizing<br>
    For informational use only · Bet responsibly
  </div>
</div>
</body>
</html>`;
}

async function sendEmail(to, from, pass, subject, html) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
  await t.sendMail({ from, to, subject, html });
  console.log('Summary email sent to', to);
}

async function main() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('Gmail credentials not set');
  if (!EMAIL_TO) throw new Error('EMAIL_TO not set');

  const yesterday = yesterdayStr();
  console.log(`Running morning summary for ${yesterday}...`);

  // Fetch yesterday's scores
  const scores = await fetchYesterdayScores(yesterday);
  console.log(`Found ${scores.length} final scores`);

  // Update DB with results
  if (scores.length > 0) {
    db.updateResults(yesterday, scores);
  }

  // Load updated data
  const allGames = db.getAllGames();
  const stats = db.getSeasonStats();
  const yesterdayGames = db.getDateGames(yesterday);

  console.log(`Season: ${stats.wins}W ${stats.losses}L, P&L: $${stats.profit}`);

  if (!yesterdayGames.length) {
    console.log('No picks found for yesterday — skipping email.');
    return;
  }

  const html = buildSummaryEmail(yesterday, yesterdayGames, allGames, stats);

  const yw = yesterdayGames.filter(g => g.result === 'W').length;
  const yl = yesterdayGames.filter(g => g.result === 'L').length;
  const dateLabel = new Date(yesterday + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  await sendEmail(
    EMAIL_TO, GMAIL_USER, GMAIL_APP_PASSWORD,
    `📊 MLB Results — ${dateLabel} · ${yw}W ${yl}L · Season: ${stats.record}`,
    html
  );

  console.log('Done!');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
