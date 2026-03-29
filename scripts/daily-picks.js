const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse failed: ' + data.slice(0, 300))); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname, path: urlPath, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('JSON parse failed: ' + d.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtOdds(o) { return o > 0 ? `+${o}` : `${o}`; }
function dec(o) { return o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1; }
function impliedProb(o) { return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100); }

function getTimeLabel() {
  const h = new Date().getUTCHours();
  if (h >= 14 && h < 17) return 'Noon';
  if (h >= 17 && h < 20) return '3 PM';
  return '6 PM';
}
function todayStr() { return new Date().toISOString().split('T')[0]; }
function ensureDataDir() {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Poisson RNG (Box-Muller free, pure Knuth) ────────────────────────────────
function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  // Knuth algorithm - fast for small lambda
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  }
  // Normal approximation for large lambda
  const u = Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, Math.round(lambda + z * Math.sqrt(lambda)));
}

// ─── Monte Carlo Simulation ───────────────────────────────────────────────────
function runSimulations(homeStats, awayStats, N = 1000000) {
  const {
    homeLambda, awayLambda,
    homeF5Lambda, awayF5Lambda,
    homeKLambda, awayKLambda,
    homeHRLambda, awayHRLambda,
    homeHitsLambda, awayHitsLambda
  } = computeLambdas(homeStats, awayStats);

  let homeWins = 0, awayWins = 0, pushes = 0;
  let homeF5Wins = 0, awayF5Wins = 0, f5Pushes = 0;
  let totalRunsSum = 0, f5RunsSum = 0;
  let totalKSum = 0, totalHRSum = 0, totalHitsSum = 0;
  const runTotals = new Array(30).fill(0);

  for (let i = 0; i < N; i++) {
    const hr = poissonSample(homeLambda);
    const ar = poissonSample(awayLambda);
    const hf5 = poissonSample(homeF5Lambda);
    const af5 = poissonSample(awayF5Lambda);
    const totalRuns = hr + ar;
    const f5Runs = hf5 + af5;

    if (hr > ar) homeWins++;
    else if (ar > hr) awayWins++;
    else pushes++;

    if (hf5 > af5) homeF5Wins++;
    else if (af5 > hf5) awayF5Wins++;
    else f5Pushes++;

    totalRunsSum += totalRuns;
    f5RunsSum += f5Runs;
    if (totalRuns < 30) runTotals[totalRuns]++;

    totalKSum += poissonSample(homeKLambda) + poissonSample(awayKLambda);
    totalHRSum += poissonSample(homeHRLambda) + poissonSample(awayHRLambda);
    totalHitsSum += poissonSample(homeHitsLambda) + poissonSample(awayHitsLambda);
  }

  const homeWinPct = homeWins / N;
  const awayWinPct = awayWins / N;
  const avgRuns = totalRunsSum / N;
  const avgF5Runs = f5RunsSum / N;

  // Confidence interval (95%) using normal approx
  const se = Math.sqrt(homeWinPct * (1 - homeWinPct) / N);
  const ciLow = Math.max(0, homeWinPct - 1.96 * se);
  const ciHigh = Math.min(1, homeWinPct + 1.96 * se);

  // Over/under distribution
  const ouLine = Math.round(avgRuns * 2) / 2; // round to nearest 0.5
  let overCount = 0;
  for (let r = 0; r < 30; r++) { if (r > ouLine) overCount += runTotals[r]; }
  const overPct = overCount / N;

  return {
    homeWinPct: +(homeWinPct * 100).toFixed(2),
    awayWinPct: +(awayWinPct * 100).toFixed(2),
    pushPct: +(pushes / N * 100).toFixed(2),
    ciLow: +(ciLow * 100).toFixed(1),
    ciHigh: +(ciHigh * 100).toFixed(1),
    projectedTotal: +avgRuns.toFixed(2),
    projectedF5Total: +avgF5Runs.toFixed(2),
    suggestedOULine: ouLine,
    overPct: +(overPct * 100).toFixed(1),
    underPct: +((1 - overPct) * 100).toFixed(1),
    homeF5WinPct: +(homeF5Wins / N * 100).toFixed(2),
    awayF5WinPct: +(awayF5Wins / N * 100).toFixed(2),
    projectedK: +(totalKSum / N).toFixed(1),
    projectedHR: +(totalHRSum / N).toFixed(2),
    projectedHits: +(totalHitsSum / N).toFixed(1),
    simulations: N
  };
}

function computeLambdas(home, away) {
  // League average runs per game ~4.5
  const lgAvg = 4.5;

  // ERA to runs: ERA / 9 * 9 = ERA per game, adjusted for bullpen
  const homePitcherERA = home.pitcherERA || 4.20;
  const awayPitcherERA = away.pitcherERA || 4.20;

  // Team offensive factor (runs scored / lgAvg)
  const homeOffFactor = (home.teamRunsPerGame || lgAvg) / lgAvg;
  const awayOffFactor = (away.teamRunsPerGame || lgAvg) / lgAvg;

  // Expected runs = pitcher ERA adjusted by opposing offense
  const homeLambda = (awayPitcherERA / 9 * 9) * homeOffFactor * (home.parkFactor || 1.0);
  const awayLambda = (homePitcherERA / 9 * 9) * awayOffFactor * (away.parkFactor || 1.0);

  // F5 = roughly 55% of full game runs
  const homeF5Lambda = homeLambda * 0.55;
  const awayF5Lambda = awayLambda * 0.55;

  // Strikeouts: K/9 * innings pitched (starter ~6 IP)
  const homeKLambda = (home.pitcherK9 || 8.5) / 9 * 6;
  const awayKLambda = (away.pitcherK9 || 8.5) / 9 * 6;

  // HRs: league avg ~1.1 HR/game per team
  const homeHRLambda = (home.teamHRRate || 1.1);
  const awayHRLambda = (away.teamHRRate || 1.1);

  // Hits: ~8.5 hits/game per team
  const homeHitsLambda = (home.teamHitsPerGame || 8.5);
  const awayHitsLambda = (away.teamHitsPerGame || 8.5);

  return { homeLambda, awayLambda, homeF5Lambda, awayF5Lambda, homeKLambda, awayKLambda, homeHRLambda, awayHRLambda, homeHitsLambda, awayHitsLambda };
}

// ─── Fetch ESPN ───────────────────────────────────────────────────────────────
async function fetchESPN() {
  const today = new Date();
  const ymd = today.getUTCFullYear() +
    String(today.getUTCMonth() + 1).padStart(2, '0') +
    String(today.getUTCDate()).padStart(2, '0');
  try {
    const data = await httpsGet(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${ymd}`);
    return (data.events || []).map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      return {
        id: e.id,
        name: e.name,
        date: e.date,
        status: e.status?.type?.description,
        venue: comp?.venue?.fullName,
        home: {
          team: home?.team?.displayName,
          abbr: home?.team?.abbreviation,
          record: home?.records?.[0]?.summary,
          pitcher: home?.probables?.[0]?.displayName,
          pitcherERA: parseFloat(home?.probables?.[0]?.statistics?.find(s => s.abbreviation === 'ERA')?.displayValue) || null,
          pitcherK9: parseFloat(home?.probables?.[0]?.statistics?.find(s => s.abbreviation === 'K/9')?.displayValue) || null,
          pitcherWHIP: parseFloat(home?.probables?.[0]?.statistics?.find(s => s.abbreviation === 'WHIP')?.displayValue) || null,
        },
        away: {
          team: away?.team?.displayName,
          abbr: away?.team?.abbreviation,
          record: away?.records?.[0]?.summary,
          pitcher: away?.probables?.[0]?.displayName,
          pitcherERA: parseFloat(away?.probables?.[0]?.statistics?.find(s => s.abbreviation === 'ERA')?.displayValue) || null,
          pitcherK9: parseFloat(away?.probables?.[0]?.statistics?.find(s => s.abbreviation === 'K/9')?.displayValue) || null,
          pitcherWHIP: parseFloat(away?.probables?.[0]?.statistics?.find(s => s.abbreviation === 'WHIP')?.displayValue) || null,
        }
      };
    });
  } catch(e) {
    console.log('ESPN fetch failed:', e.message);
    return [];
  }
}

// ─── Fetch Odds ───────────────────────────────────────────────────────────────
async function fetchOdds(oddsKey) {
  if (!oddsKey) return [];
  try {
    const data = await httpsGet(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${oddsKey}&regions=us&markets=h2h,totals&oddsFormat=american&dateFormat=iso`);
    return Array.isArray(data) ? data : [];
  } catch(e) {
    console.log('Odds API failed:', e.message);
    return [];
  }
}

// ─── Get AI context + pitcher stats ──────────────────────────────────────────
async function enrichWithAI(games, oddsData, anthropicKey) {
  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York'
  });

  const oddsMap = {};
  for (const g of oddsData) {
    const key = `${g.away_team}@${g.home_team}`;
    const bm = g.bookmakers?.find(b => b.key === 'fanduel') || g.bookmakers?.[0];
    const h2h = bm?.markets?.find(m => m.key === 'h2h');
    const totals = bm?.markets?.find(m => m.key === 'totals');
    oddsMap[key] = {
      homeOdds: h2h?.outcomes?.find(o => o.name === g.home_team)?.price,
      awayOdds: h2h?.outcomes?.find(o => o.name === g.away_team)?.price,
      ouLine: totals?.outcomes?.[0]?.point,
      commence: g.commence_time
    };
  }

  const gamesForAI = games.map(g => {
    const key = `${g.away.team}@${g.home.team}`;
    const odds = oddsMap[key] || {};
    return {
      home: g.home.team, away: g.away.team,
      venue: g.venue,
      commence: odds.commence || g.date,
      homePitcher: g.home.pitcher, homePitcherERA: g.home.pitcherERA, homePitcherK9: g.home.pitcherK9,
      awayPitcher: g.away.pitcher, awayPitcherERA: g.away.pitcherERA, awayPitcherK9: g.away.pitcherK9,
      homeRecord: g.home.record, awayRecord: g.away.record,
      homeOdds: odds.homeOdds, awayOdds: odds.awayOdds, vegasOULine: odds.ouLine
    };
  });

  const prompt = `You are an expert MLB statistician. Today is ${todayLabel}.

For each game below, provide detailed stats needed for Monte Carlo simulation. Use your knowledge of current 2026 season data.

GAMES:
${JSON.stringify(gamesForAI, null, 2)}

Return ONLY a valid JSON array:
[{
  "home_team": "full name",
  "away_team": "full name",
  "commence_time": "e.g. 7:10 PM ET",
  "home_pitcher": "name",
  "away_pitcher": "name",
  "home_pitcher_era": number,
  "away_pitcher_era": number,
  "home_pitcher_k9": number,
  "away_pitcher_k9": number,
  "home_pitcher_whip": number,
  "away_pitcher_whip": number,
  "home_team_runs_per_game": number,
  "away_team_runs_per_game": number,
  "home_team_hits_per_game": number,
  "away_team_hits_per_game": number,
  "home_team_hr_per_game": number,
  "away_team_hr_per_game": number,
  "park_factor": number (1.0 = neutral, >1 = hitter friendly),
  "home_odds": number or null,
  "away_odds": number or null,
  "vegas_ou_line": number or null,
  "reasoning": "2-3 sentences on key matchup factors, pitcher form, and betting angle"
}]

JSON only, no markdown.`;

  const result = await httpsPost('api.anthropic.com', '/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    { model: 'claude-sonnet-4-20250514', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }
  );

  const raw = result.content?.map(b => b.text || '').join('') || '';
  const clean = raw.replace(/```json|```/g, '').replace(/:\s*\+(\d)/g, ': $1').trim();
 try { return JSON.parse(clean); }
  catch(e) {
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) {
      try { return JSON.parse(m[0].replace(/:\s*\+(\d)/g, ': $1')); }
      catch(e2) {}
    }
    // Last resort: ask Claude to fix its own output
    const fix = await httpsPost('api.anthropic.com', '/v1/messages',
      { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      { model: 'claude-sonnet-4-20250514', max_tokens: 4000, messages: [
        { role: 'user', content: `Fix this JSON array so it is valid. Return ONLY the fixed JSON array, nothing else:\n\n${raw.slice(0, 8000)}` }
      ]}
    );
    const fixRaw = fix.content?.map(b => b.text || '').join('') || '';
    const fixClean = fixRaw.replace(/```json|```/g, '').replace(/:\s*\+(\d)/g, ': $1').trim();
    return JSON.parse(fixClean);
  }
}

// ─── Build full analysis per game ─────────────────────────────────────────────
function analyzeGame(aiGame) {
  const homeStats = {
    pitcherERA: aiGame.home_pitcher_era || 4.20,
    pitcherK9: aiGame.home_pitcher_k9 || 8.5,
    teamRunsPerGame: aiGame.home_team_runs_per_game || 4.5,
    teamHitsPerGame: aiGame.home_team_hits_per_game || 8.5,
    teamHRRate: aiGame.home_team_hr_per_game || 1.1,
    parkFactor: aiGame.park_factor || 1.0
  };
  const awayStats = {
    pitcherERA: aiGame.away_pitcher_era || 4.20,
    pitcherK9: aiGame.away_pitcher_k9 || 8.5,
    teamRunsPerGame: aiGame.away_team_runs_per_game || 4.5,
    teamHitsPerGame: aiGame.away_team_hits_per_game || 8.5,
    teamHRRate: aiGame.away_team_hr_per_game || 1.1,
    parkFactor: 1.0
  };

  console.log(`  Simulating ${aiGame.away_team} @ ${aiGame.home_team}...`);
  const sim = runSimulations(homeStats, awayStats, 1000000);

  // EV calculation using sim probabilities vs Vegas
  const homeOdds = aiGame.home_odds;
  const awayOdds = aiGame.away_odds;
  let pick, pickOdds, ourProb, impliedP, ev, kelly;

  if (homeOdds && awayOdds) {
    const homeImplied = impliedProb(homeOdds);
    const awayImplied = impliedProb(awayOdds);
    const homeEV = (sim.homeWinPct / 100 * dec(homeOdds) - 1) * 100;
    const awayEV = (sim.awayWinPct / 100 * dec(awayOdds) - 1) * 100;
    if (homeEV >= awayEV) {
      pick = aiGame.home_team; pickOdds = homeOdds;
      ourProb = sim.homeWinPct / 100; impliedP = homeImplied; ev = homeEV;
    } else {
      pick = aiGame.away_team; pickOdds = awayOdds;
      ourProb = sim.awayWinPct / 100; impliedP = awayImplied; ev = awayEV;
    }
    const d = dec(pickOdds);
    kelly = Math.max(0, Math.min(25, ((ourProb * d - 1) / (d - 1)) * 100));
  } else {
    // No odds — use sim to pick side
    if (sim.homeWinPct >= sim.awayWinPct) {
      pick = aiGame.home_team; pickOdds = -120; ourProb = sim.homeWinPct / 100;
    } else {
      pick = aiGame.away_team; pickOdds = 100; ourProb = sim.awayWinPct / 100;
    }
    impliedP = impliedProb(pickOdds);
    ev = (ourProb * dec(pickOdds) - 1) * 100;
    kelly = Math.max(0, Math.min(25, ((ourProb * dec(pickOdds) - 1) / (dec(pickOdds) - 1)) * 100));
  }

  // O/U recommendation
  const vegasOU = aiGame.vegas_ou_line;
  let ouPick = null, ouEdge = null;
  if (vegasOU) {
    if (sim.projectedTotal > vegasOU + 0.3) { ouPick = 'OVER'; ouEdge = sim.projectedTotal - vegasOU; }
    else if (sim.projectedTotal < vegasOU - 0.3) { ouPick = 'UNDER'; ouEdge = vegasOU - sim.projectedTotal; }
  }

  return {
    home_team: aiGame.home_team,
    away_team: aiGame.away_team,
    commence_time: aiGame.commence_time,
    home_pitcher: aiGame.home_pitcher,
    away_pitcher: aiGame.away_pitcher,
    pick, pickOdds, ev, kelly,
    ourProb, impliedP,
    sim,
    vegasOU, ouPick, ouEdge,
    reasoning: aiGame.reasoning,
    odds_source: homeOdds ? 'The Odds API (live)' : 'Estimated'
  };
}

// ─── Email Builder ────────────────────────────────────────────────────────────
function evColor(ev) { return ev > 5 ? '#16a34a' : ev > 0 ? '#65a30d' : ev > -5 ? '#ca8a04' : '#dc2626'; }
function confColor(s) { return s >= 70 ? '#16a34a' : s >= 55 ? '#ca8a04' : '#dc2626'; }

function buildPicksEmail(analyzed, timeLabel, bankroll = 1000) {
  const sorted = [...analyzed].sort((a, b) => b.ev - a.ev);
  const best = sorted[0];
  const posEV = sorted.filter(g => g.ev > 0).length;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

  const gameCards = sorted.map((g, i) => {
    const ec = evColor(g.ev);
    const isBest = i === 0;
    const bet = ((g.kelly / 100) * bankroll).toFixed(0);
    const evSign = g.ev > 0 ? '+' : '';
    const s = g.sim;

    const ouRow = g.vegasOU ? `
      <tr><td style="padding:6px 0;color:#6b7280;font-size:12px">O/U Line</td><td style="padding:6px 0;font-size:12px;text-align:right;font-weight:600">${g.vegasOU} ${g.ouPick ? `→ <span style="color:${g.ouPick==='OVER'?'#16a34a':'#dc2626'}">${g.ouPick} (edge: ${g.ouEdge?.toFixed(1)} runs)</span>` : '(neutral)'}</td></tr>` : '';

    return `
<div style="background:${isBest ? '#f0fdf4' : '#ffffff'};border:1px solid ${isBest ? '#86efac' : '#e5e7eb'};border-radius:12px;padding:20px;margin-bottom:16px">
  ${isBest ? '<div style="background:#16a34a;color:#fff;font-size:11px;font-weight:600;padding:2px 12px;border-radius:4px;display:inline-block;margin-bottom:10px;letter-spacing:1px">⚡ BEST VALUE</div>' : ''}

  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px">
    <div>
      <div style="font-size:16px;font-weight:700;color:#111827">${g.away_team} @ ${g.home_team}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px">${g.commence_time || ''} · ${g.odds_source}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px">⚾ ${g.away_pitcher || 'TBD'} vs ${g.home_pitcher || 'TBD'}</div>
    </div>
    <div style="text-align:right">
      <span style="background:${ec}18;border:1px solid ${ec}44;color:${ec};border-radius:4px;padding:3px 10px;font-size:13px;font-weight:700">${evSign}${g.ev.toFixed(1)}% EV</span>
    </div>
  </div>

  <!-- Main Pick -->
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px">
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Pick</div>
      <div style="font-size:15px;font-weight:700;color:${ec}">${g.pick}</div>
      <div style="font-size:12px;color:#6b7280">${fmtOdds(g.pickOdds)}</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Kelly Bet</div>
      <div style="font-size:15px;font-weight:700;color:#111827">$${bet}</div>
      <div style="font-size:12px;color:#6b7280">${g.kelly.toFixed(1)}% of bankroll</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:120px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Win Probability</div>
      <div style="font-size:15px;font-weight:700;color:#111827">${g.ourProb > 0.5 ? (g.ourProb * 100).toFixed(1) : ((1 - g.ourProb) * 100).toFixed(1)}%</div>
      <div style="font-size:12px;color:#6b7280">Implied: ${(g.impliedP * 100).toFixed(1)}%</div>
    </div>
  </div>

  <!-- Simulation Results -->
  <div style="background:#eff6ff;border-radius:8px;padding:14px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:600;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">🎲 1,000,000 Game Simulation Results</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr>
        <td style="padding:5px 0;color:#374151;width:50%"><strong>${g.home_team}</strong> win</td>
        <td style="padding:5px 0;color:#374151;text-align:right"><strong>${s.homeWinPct}%</strong></td>
        <td style="padding:5px 0;color:#374151;width:50%;padding-left:16px"><strong>${g.away_team}</strong> win</td>
        <td style="padding:5px 0;color:#374151;text-align:right"><strong>${s.awayWinPct}%</strong></td>
      </tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280" colspan="2">95% Confidence interval</td>
        <td style="padding:5px 0;text-align:right;font-weight:600;color:#1d4ed8" colspan="2">${s.ciLow}% – ${s.ciHigh}%</td>
      </tr>
      <tr><td colspan="4"><hr style="border:none;border-top:1px solid #dbeafe;margin:6px 0"></td></tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280">Projected total runs</td>
        <td style="padding:5px 0;font-weight:600;text-align:right" colspan="3">${s.projectedTotal}</td>
      </tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280">F5 projected total</td>
        <td style="padding:5px 0;font-weight:600;text-align:right" colspan="3">${s.projectedF5Total}</td>
      </tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280">F5 result</td>
        <td style="padding:5px 0;font-weight:600;text-align:right" colspan="3">${g.home_team} ${s.homeF5WinPct}% · ${g.away_team} ${s.awayF5WinPct}%</td>
      </tr>
      ${ouRow}
      <tr><td colspan="4"><hr style="border:none;border-top:1px solid #dbeafe;margin:6px 0"></td></tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280">Projected strikeouts</td>
        <td style="padding:5px 0;font-weight:600;text-align:right" colspan="3">${s.projectedK} K</td>
      </tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280">Projected home runs</td>
        <td style="padding:5px 0;font-weight:600;text-align:right" colspan="3">${s.projectedHR} HR</td>
      </tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280">Projected hits</td>
        <td style="padding:5px 0;font-weight:600;text-align:right" colspan="3">${s.projectedHits} hits</td>
      </tr>
      <tr>
        <td style="padding:5px 0;color:#6b7280">Over / Under</td>
        <td style="padding:5px 0;font-weight:600;text-align:right" colspan="3">Over ${s.overPct}% · Under ${s.underPct}%</td>
      </tr>
    </table>
  </div>

  <!-- Reasoning -->
  <div style="background:#f9fafb;border-radius:6px;padding:10px 14px;border-left:3px solid #16a34a;font-size:13px;color:#6b7280;line-height:1.6">
    <span style="color:#16a34a;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">AI Analysis · </span>${g.reasoning}
  </div>
</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:20px">
<div style="max-width:660px;margin:0 auto">

  <div style="background:linear-gradient(135deg,#14532d,#16a34a);border-radius:14px;padding:28px;margin-bottom:20px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">⚾</div>
    <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px">MLB Value Picks</div>
    <div style="color:#bbf7d0;font-size:13px;margin-top:6px">${timeLabel} · ${today}</div>
    <div style="color:#86efac;font-size:11px;margin-top:4px">Powered by 1,000,000 Monte Carlo simulations per game</div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
    <div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
      <div style="font-size:24px;font-weight:700;color:#16a34a">${sorted.length}</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">Games</div>
    </div>
    <div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
      <div style="font-size:24px;font-weight:700;color:#16a34a">${posEV}</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">+EV Games</div>
    </div>
    <div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
      <div style="font-size:24px;font-weight:700;color:#16a34a">${best ? (best.ev > 0 ? '+' : '') + best.ev.toFixed(1) + '%' : '—'}</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">Best EV</div>
    </div>
    <div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
      <div style="font-size:24px;font-weight:700;color:#16a34a">${best ? '$' + ((best.kelly / 100) * bankroll).toFixed(0) : '—'}</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">Top Bet</div>
    </div>
  </div>

  ${gameCards}

  <div style="text-align:center;color:#9ca3af;font-size:11px;padding:16px;line-height:1.8">
    Kelly capped at 25% · Monte Carlo uses Poisson run distribution model<br>
    For informational use only · Bet responsibly
  </div>
</div>
</body>
</html>`;
}

// ─── Save ─────────────────────────────────────────────────────────────────────
function savePicks(analyzed, dataDir) {
  const date = todayStr();
  const file = path.join(dataDir, `picks-${date}.json`);
  const existing = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { date, games: [], sent_at: [] };
  existing.games = analyzed.map(g => ({
    home_team: g.home_team, away_team: g.away_team,
    commence_time: g.commence_time, pick: g.pick,
    pick_odds: g.pickOdds, ev: g.ev, kelly: g.kelly,
    sim_home_win_pct: g.sim.homeWinPct,
    sim_away_win_pct: g.sim.awayWinPct,
  }));
  existing.sent_at = [...(existing.sent_at || []), new Date().toISOString()];
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  console.log('Saved picks to', file);
}

async function sendEmail(to, from, appPassword, subject, htmlBody) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass: appPassword }
  });
  await transporter.sendMail({ from, to, subject, html: htmlBody });
  console.log('Email sent to', to);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { ANTHROPIC_API_KEY, ODDS_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO } = process.env;
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error('Gmail credentials not set');
  if (!EMAIL_TO) throw new Error('EMAIL_TO not set');

  const dataDir = ensureDataDir();
  const timeLabel = getTimeLabel();
  console.log(`Running ${timeLabel} picks email with Monte Carlo simulations...`);

  const [espnGames, oddsData] = await Promise.all([
    fetchESPN(),
    fetchOdds(ODDS_API_KEY)
  ]);
  console.log(`ESPN: ${espnGames.length} games | Odds: ${oddsData.length} games`);

  console.log('Getting AI enrichment + pitcher stats...');
  const aiGames = await enrichWithAI(espnGames, oddsData, ANTHROPIC_API_KEY);
  console.log(`AI enriched ${aiGames.length} games`);

  console.log('Running 1,000,000 simulations per game...');
  const analyzed = aiGames.map(analyzeGame).sort((a, b) => b.ev - a.ev);

  savePicks(analyzed, dataDir);

  const html = buildPicksEmail(analyzed, timeLabel);
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  await sendEmail(EMAIL_TO, GMAIL_USER, GMAIL_APP_PASSWORD,
    `⚾ MLB Picks — ${timeLabel} · ${date} · ${analyzed.filter(g => g.ev > 0).length} +EV games`, html);
  console.log('Done!');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
