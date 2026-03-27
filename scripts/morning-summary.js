const https = require('https');
const fs = require('fs');
const path = require('path');

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + data.slice(0,200))); }
      });
    }).on('error', reject);
  });
}

function fmtOdds(o) { return o > 0 ? `+${o}` : `${o}`; }
function dec(o) { return o > 0 ? o/100+1 : 100/Math.abs(o)+1; }

function ensureDataDir() {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function yesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

function loadRecord(dataDir) {
  const file = path.join(dataDir, 'record.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return { wins: 0, losses: 0, pushes: 0, profit: 0, start_date: new Date().toISOString().split('T')[0] };
}

function saveRecord(dataDir, record) {
  fs.writeFileSync(path.join(dataDir, 'record.json'), JSON.stringify(record, null, 2));
}

async function fetchYesterdayScores() {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const ymd = yesterday.getUTCFullYear() +
    String(yesterday.getUTCMonth()+1).padStart(2,'0') +
    String(yesterday.getUTCDate()).padStart(2,'0');

  try {
    const data = await httpsGet(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${ymd}`);
    const games = {};
    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const competitors = comp.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) continue;
      const homeScore = parseInt(home.score || '0');
      const awayScore = parseInt(away.score || '0');
      const status = event.status?.type?.completed;
      if (!status) continue;
      const winner = homeScore > awayScore ? home.team?.displayName : away.team?.displayName;
      const key = `${away.team?.displayName}@${home.team?.displayName}`;
      games[key] = { home: home.team?.displayName, away: away.team?.displayName, homeScore, awayScore, winner };
    }
    return games;
  } catch(e) {
    console.log('Score fetch failed:', e.message);
    return {};
  }
}

function matchResult(pick, scores) {
  for (const [key, game] of Object.entries(scores)) {
    if (game.home === pick.home_team && game.away === pick.away_team) {
      if (game.homeScore === game.awayScore) return 'P';
      return game.winner === pick.pick ? 'W' : 'L';
    }
  }
  return null;
}

async function sendEmail(to, from, appPassword, subject, htmlBody) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass: appPassword }
  });
  await transporter.sendMail({ from, to, subject, html: htmlBody });
  console.log('Summary email sent to', to);
}

function buildSummaryEmail(yesterdayDate, results, overallRecord, bankroll = 1000) {
  const wins = results.filter(r => r.result === 'W').length;
  const losses = results.filter(r => r.result === 'L').length;
  const pushes = results.filter(r => r.result === 'P').length;
  const noResult = results.filter(r => r.result === null).length;

  const dayProfit = results.reduce((acc, r) => {
    if (r.result === 'W') return acc + (dec(r.pick_odds) - 1) * r.bet_amount;
    if (r.result === 'L') return acc - r.bet_amount;
    return acc;
  }, 0);

  const overallW = overallRecord.wins;
  const overallL = overallRecord.losses;
  const overallTotal = overallW + overallL;
  const overallPct = overallTotal > 0 ? (overallW / overallTotal * 100).toFixed(1) : '—';
  const overallProfit = overallRecord.profit || 0;

  const resultIcon = (r) => r === 'W' ? '✅' : r === 'L' ? '❌' : r === 'P' ? '➖' : '⏳';
  const resultLabel = (r) => r === 'W' ? 'WIN' : r === 'L' ? 'LOSS' : r === 'P' ? 'PUSH' : 'PENDING';
  const resultColor = (r) => r === 'W' ? '#16a34a' : r === 'L' ? '#dc2626' : r === 'P' ? '#6b7280' : '#ca8a04';

  const pickRows = results.map(r => `
    <tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:10px 8px;font-size:13px;font-weight:500">${r.pick}</td>
      <td style="padding:10px 8px;font-size:12px;color:#6b7280">${r.away_team} @ ${r.home_team}</td>
      <td style="padding:10px 8px;font-size:12px;color:#6b7280">${r.commence_time || ''}</td>
      <td style="padding:10px 8px;font-size:12px;color:#6b7280">${fmtOdds(r.pick_odds)}</td>
      <td style="padding:10px 8px;font-size:12px">$${r.bet_amount.toFixed(0)}</td>
      <td style="padding:10px 8px;text-align:center">
        <span style="background:${resultColor(r.result)}18;border:1px solid ${resultColor(r.result)}55;color:${resultColor(r.result)};border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600">
          ${resultIcon(r.result)} ${resultLabel(r.result)}
        </span>
      </td>
    </tr>`).join('');

  const dateLabel = new Date(yesterdayDate + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  return `
<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:20px">
<div style="max-width:660px;margin:0 auto">

  <div style="background:linear-gradient(135deg,#1e3a5f,#1d4ed8);border-radius:12px;padding:24px;margin-bottom:20px;text-align:center">
    <div style="font-size:28px;margin-bottom:6px">📊</div>
    <div style="color:#fff;font-size:20px;font-weight:700">Morning Results</div>
    <div style="color:#bfdbfe;font-size:13px;margin-top:4px">${dateLabel}</div>
  </div>

  <!-- Yesterday's record -->
  <div style="background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #e5e7eb">
    <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">Yesterday's Results</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div style="flex:1;min-width:80px;background:#f0fdf4;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#16a34a">${wins}</div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">Wins</div>
      </div>
      <div style="flex:1;min-width:80px;background:#fef2f2;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#dc2626">${losses}</div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">Losses</div>
      </div>
      <div style="flex:1;min-width:80px;background:#f9fafb;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#6b7280">${pushes}</div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">Pushes</div>
      </div>
      <div style="flex:1;min-width:80px;background:${dayProfit >= 0 ? '#f0fdf4' : '#fef2f2'};border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:${dayProfit >= 0 ? '#16a34a' : '#dc2626'}">${dayProfit >= 0 ? '+' : ''}$${dayProfit.toFixed(0)}</div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">P&L</div>
      </div>
    </div>
    ${noResult > 0 ? `<div style="font-size:12px;color:#ca8a04;background:#fefce8;border-radius:6px;padding:8px 12px">${noResult} game(s) result not yet available — scores may still be in progress.</div>` : ''}
  </div>

  <!-- Overall record -->
  <div style="background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #e5e7eb">
    <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">Overall Record (since ${overallRecord.start_date})</div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:80px;background:#f9fafb;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#16a34a">${overallW}W <span style="color:#dc2626">${overallL}L</span></div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">Record</div>
      </div>
      <div style="flex:1;min-width:80px;background:#f9fafb;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#111827">${overallPct}${overallPct !== '—' ? '%' : ''}</div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">Win Rate</div>
      </div>
      <div style="flex:1;min-width:80px;background:${overallProfit >= 0 ? '#f0fdf4' : '#fef2f2'};border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:${overallProfit >= 0 ? '#16a34a' : '#dc2626'}">${overallProfit >= 0 ? '+' : ''}$${overallProfit.toFixed(0)}</div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px">Total P&L</div>
      </div>
    </div>
  </div>

  <!-- Pick breakdown table -->
  <div style="background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;border:1px solid #e5e7eb">
    <div style="font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px">Pick Breakdown</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="border-bottom:2px solid #f3f4f6">
          <th style="text-align:left;padding:8px;font-size:11px;color:#9ca3af;font-weight:500;text-transform:uppercase">Pick</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:#9ca3af;font-weight:500;text-transform:uppercase">Matchup</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:#9ca3af;font-weight:500;text-transform:uppercase">Time</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:#9ca3af;font-weight:500;text-transform:uppercase">Odds</th>
          <th style="text-align:left;padding:8px;font-size:11px;color:#9ca3af;font-weight:500;text-transform:uppercase">Bet</th>
          <th style="text-align:center;padding:8px;font-size:11px;color:#9ca3af;font-weight:500;text-transform:uppercase">Result</th>
        </tr>
      </thead>
      <tbody>${pickRows}</tbody>
    </table>
  </div>

  <div style="text-align:center;color:#9ca3af;font-size:11px;padding:12px">
    For informational use only · Bet responsibly
  </div>
</div>
</body>
</html>`;
}

async function main() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('Gmail credentials not set');
  if (!EMAIL_TO) throw new Error('EMAIL_TO not set');

  const dataDir = ensureDataDir();
  const yesterday = yesterdayStr();
  const picksFile = path.join(dataDir, `picks-${yesterday}.json`);

  console.log(`Running morning summary for ${yesterday}...`);

  if (!fs.existsSync(picksFile)) {
    console.log('No picks file for yesterday, skipping summary.');
    return;
  }

  const picksData = JSON.parse(fs.readFileSync(picksFile, 'utf8'));
  const picks = picksData.games || [];

  if (!picks.length) {
    console.log('No picks recorded for yesterday.');
    return;
  }

  const scores = await fetchYesterdayScores();
  console.log(`Fetched ${Object.keys(scores).length} game scores`);

  const bankroll = 1000;
  const results = picks.map(p => ({
    ...p,
    bet_amount: (p.kelly_fraction / 100) * bankroll,
    result: matchResult(p, scores)
  }));

  // Update overall record
  const record = loadRecord(dataDir);
  const wins = results.filter(r => r.result === 'W').length;
  const losses = results.filter(r => r.result === 'L').length;
  const pushes = results.filter(r => r.result === 'P').length;
  const dayProfit = results.reduce((acc, r) => {
    if (r.result === 'W') return acc + (dec(r.pick_odds) - 1) * r.bet_amount;
    if (r.result === 'L') return acc - r.bet_amount;
    return acc;
  }, 0);

  record.wins += wins;
  record.losses += losses;
  record.pushes = (record.pushes || 0) + pushes;
  record.profit = (record.profit || 0) + dayProfit;
  saveRecord(dataDir, record);

  // Save results back to picks file
  picksData.results = results;
  picksData.scored_at = new Date().toISOString();
  fs.writeFileSync(picksFile, JSON.stringify(picksData, null, 2));

  const html = buildSummaryEmail(yesterday, results, record);
  const dateLabel = new Date(yesterday + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  await sendEmail(EMAIL_TO, GMAIL_USER, GMAIL_APP_PASSWORD, `📊 MLB Results — ${dateLabel} · ${wins}W ${losses}L`, html);

  console.log(`Done! ${wins}W ${losses}L overall: ${record.wins}W ${record.losses}L`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
