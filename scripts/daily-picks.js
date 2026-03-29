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
        catch(e) { reject(new Error('JSON parse: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path: urlPath, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch(e) { reject(new Error('JSON parse: ' + d.slice(0, 200))); }
        });
      }
    );
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
function safeNum(v, fallback) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

// ─── Poisson Simulation ───────────────────────────────────────────────────────
function poissonSample(lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
  }
  const u = Math.random(), v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, Math.round(lambda + z * Math.sqrt(lambda)));
}

function runMonteCarlo(homeStats, awayStats, N = 1000000) {
  const lgAvgRPG = 4.5;
  const lgAvgHPG = 8.5;
  const lgAvgHRPG = 1.1;
  const lgAvgKPG = 8.5;

  // Expected runs per game using FIP-like approach
  // Starter covers ~5.5 innings, bullpen ~3.5
  const starterIP = 5.5;
  const bullpenIP = 3.5;

  const homeStarterRuns = (safeNum(homeStats.starterERA, 4.20) / 9) * starterIP;
  const homeBullpenRuns = (safeNum(homeStats.bullpenERA, 4.00) / 9) * bullpenIP;
  const homeAllowedPerGame = homeStarterRuns + homeBullpenRuns;

  const awayStarterRuns = (safeNum(awayStats.starterERA, 4.20) / 9) * starterIP;
  const awayBullpenRuns = (safeNum(awayStats.bullpenERA, 4.00) / 9) * bullpenIP;
  const awayAllowedPerGame = awayStarterRuns + awayBullpenRuns;

  // Offensive factor relative to league avg
  const homeOffFactor = safeNum(homeStats.teamRPG, lgAvgRPG) / lgAvgRPG;
  const awayOffFactor = safeNum(awayStats.teamRPG, lgAvgRPG) / lgAvgRPG;

  // Park factor adjustment
  const parkFactor = safeNum(homeStats.parkFactor, 1.0);

  // Final run lambdas
  const homeLambda = awayAllowedPerGame * homeOffFactor * parkFactor;
  const awayLambda = homeAllowedPerGame * awayOffFactor;

  // F5 = ~55% of game runs
  const homeF5L = homeLambda * 0.55;
  const awayF5L = awayLambda * 0.55;

  // Prop lambdas
  const homeKL = (safeNum(homeStats.starterK9, lgAvgKPG) / 9) * starterIP + (safeNum(homeStats.bullpenK9, 8.0) / 9) * bullpenIP;
  const awayKL = (safeNum(awayStats.starterK9, lgAvgKPG) / 9) * starterIP + (safeNum(awayStats.bullpenK9, 8.0) / 9) * bullpenIP;
  const homeHRL = safeNum(homeStats.teamHRPG, lgAvgHRPG);
  const awayHRL = safeNum(awayStats.teamHRPG, lgAvgHRPG);
  const homeHitsL = safeNum(homeStats.teamHPG, lgAvgHPG);
  const awayHitsL = safeNum(awayStats.teamHPG, lgAvgHPG);

  // Simulate
  let hW = 0, aW = 0, push = 0, hF5 = 0, aF5 = 0, f5P = 0;
  let runSum = 0, f5Sum = 0, kSum = 0, hrSum = 0, hitsSum = 0;
  const runDist = new Array(35).fill(0);

  for (let i = 0; i < N; i++) {
    const hr = poissonSample(homeLambda);
    const ar = poissonSample(awayLambda);
    const hf = poissonSample(homeF5L);
    const af = poissonSample(awayF5L);
    const total = hr + ar;

    if (hr > ar) hW++;
    else if (ar > hr) aW++;
    else push++;

    if (hf > af) hF5++;
    else if (af > hf) aF5++;
    else f5P++;

    runSum += total;
    f5Sum += hf + af;
    if (total < 35) runDist[total]++;
    kSum += poissonSample(homeKL) + poissonSample(awayKL);
    hrSum += poissonSample(homeHRL) + poissonSample(awayHRL);
    hitsSum += poissonSample(homeHitsL) + poissonSample(awayHitsL);
  }

  const homeWinPct = hW / N;
  const awayWinPct = aW / N;
  const avgRuns = runSum / N;
  const se = Math.sqrt(homeWinPct * (1 - homeWinPct) / N);
  const suggestedLine = Math.round(avgRuns * 2) / 2;

  let overCount = 0;
  for (let r = Math.ceil(suggestedLine); r < 35; r++) overCount += runDist[r];

  return {
    homeWinPct: +(homeWinPct * 100).toFixed(2),
    awayWinPct: +(awayWinPct * 100).toFixed(2),
    pushPct: +(push / N * 100).toFixed(2),
    ciLow: +((homeWinPct - 1.96 * se) * 100).toFixed(1),
    ciHigh: +((homeWinPct + 1.96 * se) * 100).toFixed(1),
    projectedTotal: +avgRuns.toFixed(2),
    projectedF5Total: +(f5Sum / N).toFixed(2),
    suggestedOULine: suggestedLine,
    overPct: +(overCount / N * 100).toFixed(1),
    underPct: +((1 - overCount / N) * 100).toFixed(1),
    homeF5WinPct: +(hF5 / N * 100).toFixed(2),
    awayF5WinPct: +(aF5 / N * 100).toFixed(2),
    projectedK: +(kSum / N).toFixed(1),
    projectedHR: +(hrSum / N).toFixed(2),
    projectedHits: +(hitsSum / N).toFixed(1),
    homeLambda: +homeLambda.toFixed(3),
    awayLambda: +awayLambda.toFixed(3),
  };
}

// ─── MLB Stats API ────────────────────────────────────────────────────────────
const MLB_BASE = 'statsapi.mlb.com';

async function fetchMLBSchedule() {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  try {
    const data = await httpsGet(
      `https://${MLB_BASE}/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher(stats),team,linescore,broadcasts,venue`
    );
    return data.dates?.[0]?.games || [];
  } catch(e) {
    console.log('MLB schedule fetch failed:', e.message);
    return [];
  }
}

async function fetchPitcherStats(personId) {
  if (!personId) return {};
  try {
    const [season, last30] = await Promise.all([
      httpsGet(`https://${MLB_BASE}/api/v1/people/${personId}/stats?stats=season&group=pitching&season=2026`),
      httpsGet(`https://${MLB_BASE}/api/v1/people/${personId}/stats?stats=lastXGames&group=pitching&season=2026&limit=7`)
    ]);
    const s = season.stats?.[0]?.splits?.[0]?.stat || {};
    const r = last30.stats?.[0]?.splits?.[0]?.stat || {};
    return {
      era: safeNum(s.era, null),
      whip: safeNum(s.whip, null),
      k9: safeNum(s.strikeoutsPer9Inn, null),
      bb9: safeNum(s.walksPer9Inn, null),
      hr9: safeNum(s.homeRunsPer9, null),
      ip: safeNum(s.inningsPitched, null),
      fip: safeNum(s.fielding, null),
      recentERA: safeNum(r.era, null),
      recentWHIP: safeNum(r.whip, null),
    };
  } catch(e) {
    return {};
  }
}

async function fetchTeamStats(teamId) {
  if (!teamId) return {};
  try {
    const [hitting, pitching] = await Promise.all([
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=2026`),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=2026`)
    ]);
    const h = hitting.stats?.[0]?.splits?.[0]?.stat || {};
    const p = pitching.stats?.[0]?.splits?.[0]?.stat || {};
    const gamesPlayed = safeNum(h.gamesPlayed, 1);
    return {
      runsPerGame: safeNum(h.runs, 0) / gamesPlayed,
      hitsPerGame: safeNum(h.hits, 0) / gamesPlayed,
      hrPerGame: safeNum(h.homeRuns, 0) / gamesPlayed,
      obp: safeNum(h.obp, null),
      slg: safeNum(h.slg, null),
      avg: safeNum(h.avg, null),
      bullpenERA: safeNum(p.era, 4.00),
      bullpenK9: safeNum(p.strikeoutsPer9Inn, 8.5),
      gamesPlayed,
    };
  } catch(e) {
    return {};
  }
}

async function fetchVenueInfo(venueId) {
  // Park factors from known venues (approximate 2025 values)
  const parkFactors = {
    2392: 1.15, // Coors Field (COL)
    2395: 1.08, // Great American Ball Park (CIN)
    4169: 1.06, // Fenway Park (BOS)
    2394: 1.05, // Wrigley Field (CHC)
    32: 1.04,   // Yankee Stadium
    4705: 1.03, // Globe Life Field (TEX)
    2393: 0.97, // Petco Park (SD)
    680: 0.96,  // Tropicana Field (TB)
    3309: 0.95, // Oracle Park (SF)
    2681: 0.94, // T-Mobile Park (SEA)
    2602: 0.93, // Dodger Stadium (LAD)
  };
  return { parkFactor: parkFactors[venueId] || 1.0 };
}

async function buildGameData(games) {
  const results = [];
  for (const game of games) {
    if (game.status?.abstractGameState === 'Final') continue;
    const homePitcherId = game.teams?.home?.probablePitcher?.id;
    const awayPitcherId = game.teams?.away?.probablePitcher?.id;
    const homeTeamId = game.teams?.home?.team?.id;
    const awayTeamId = game.teams?.away?.team?.id;
    const venueId = game.venue?.id;

    console.log(`  Fetching stats for ${game.teams?.away?.team?.name} @ ${game.teams?.home?.team?.name}...`);

    const [homePitcher, awayPitcher, homeTeam, awayTeam, venue] = await Promise.all([
      fetchPitcherStats(homePitcherId),
      fetchPitcherStats(awayPitcherId),
      fetchTeamStats(homeTeamId),
      fetchTeamStats(awayTeamId),
      fetchVenueInfo(venueId),
    ]);

    // Use recent ERA if available (last 7 games), fallback to season, fallback to league avg
    const homeStarterERA = homePitcher.recentERA || homePitcher.era || 4.20;
    const awayStarterERA = awayPitcher.recentERA || awayPitcher.era || 4.20;

    results.push({
      gamePk: game.gamePk,
      homeTeam: game.teams?.home?.team?.name,
      awayTeam: game.teams?.away?.team?.name,
      homeTeamId,
      awayTeamId,
      venue: game.venue?.name,
      venueId,
      gameTime: game.gameDate,
      homePitcherName: game.teams?.home?.probablePitcher?.fullName || 'TBD',
      awayPitcherName: game.teams?.away?.probablePitcher?.fullName || 'TBD',
      homeStats: {
        starterERA: homeStarterERA,
        starterSeasonERA: homePitcher.era,
        starterK9: homePitcher.k9 || 8.5,
        starterWHIP: homePitcher.whip,
        starterBB9: homePitcher.bb9,
        bullpenERA: homeTeam.bullpenERA || 4.00,
        bullpenK9: homeTeam.bullpenK9 || 8.5,
        teamRPG: homeTeam.runsPerGame || 4.5,
        teamHPG: homeTeam.hitsPerGame || 8.5,
        teamHRPG: homeTeam.hrPerGame || 1.1,
        teamOBP: homeTeam.obp,
        teamSLG: homeTeam.slg,
        teamAVG: homeTeam.avg,
        gamesPlayed: homeTeam.gamesPlayed || 0,
        parkFactor: venue.parkFactor,
      },
      awayStats: {
        starterERA: awayStarterERA,
        starterSeasonERA: awayPitcher.era,
        starterK9: awayPitcher.k9 || 8.5,
        starterWHIP: awayPitcher.whip,
        starterBB9: awayPitcher.bb9,
        bullpenERA: awayTeam.bullpenERA || 4.00,
        bullpenK9: awayTeam.bullpenK9 || 8.5,
        teamRPG: awayTeam.runsPerGame || 4.5,
        teamHPG: awayTeam.hitsPerGame || 8.5,
        teamHRPG: awayTeam.hrPerGame || 1.1,
        teamOBP: awayTeam.obp,
        teamSLG: awayTeam.slg,
        teamAVG: awayTeam.avg,
        gamesPlayed: awayTeam.gamesPlayed || 0,
        parkFactor: 1.0,
      },
    });
  }
  return results;
}

// ─── Odds API ─────────────────────────────────────────────────────────────────
async function fetchOdds(oddsKey) {
  if (!oddsKey) return [];
  try {
    const data = await httpsGet(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=${oddsKey}&regions=us&markets=h2h,totals&oddsFormat=american&dateFormat=iso`
    );
    return Array.isArray(data) ? data : [];
  } catch(e) {
    console.log('Odds API failed:', e.message);
    return [];
  }
}

function matchOdds(game, oddsData) {
  for (const o of oddsData) {
    if (
      (o.home_team?.includes(game.homeTeam?.split(' ').pop()) ||
       game.homeTeam?.includes(o.home_team?.split(' ').pop())) &&
      (o.away_team?.includes(game.awayTeam?.split(' ').pop()) ||
       game.awayTeam?.includes(o.away_team?.split(' ').pop()))
    ) {
      const bm = o.bookmakers?.find(b => b.key === 'fanduel') ||
                 o.bookmakers?.find(b => b.key === 'draftkings') ||
                 o.bookmakers?.[0];
      const h2h = bm?.markets?.find(m => m.key === 'h2h');
      const totals = bm?.markets?.find(m => m.key === 'totals');
      return {
        homeOdds: h2h?.outcomes?.find(out => out.name === o.home_team)?.price,
        awayOdds: h2h?.outcomes?.find(out => out.name === o.away_team)?.price,
        ouLine: totals?.outcomes?.[0]?.point,
        bookmaker: bm?.title || 'Unknown',
      };
    }
  }
  return {};
}

// ─── AI Reasoning ─────────────────────────────────────────────────────────────
async function getAIReasoning(games, anthropicKey) {
  const summary = games.map(g => ({
    matchup: `${g.awayTeam} @ ${g.homeTeam}`,
    homePitcher: `${g.homePitcherName} (ERA: ${g.homeStats.starterERA?.toFixed(2)}, K/9: ${g.homeStats.starterK9?.toFixed(1)}, WHIP: ${g.homeStats.starterWHIP?.toFixed(2) || 'N/A'})`,
    awayPitcher: `${g.awayPitcherName} (ERA: ${g.awayStats.starterERA?.toFixed(2)}, K/9: ${g.awayStats.starterK9?.toFixed(1)}, WHIP: ${g.awayStats.starterWHIP?.toFixed(2) || 'N/A'})`,
    homeTeamStats: `RPG: ${g.homeStats.teamRPG?.toFixed(2)}, OBP: ${g.homeStats.teamOBP || 'N/A'}, SLG: ${g.homeStats.teamSLG || 'N/A'}`,
    awayTeamStats: `RPG: ${g.awayStats.teamRPG?.toFixed(2)}, OBP: ${g.awayStats.teamOBP || 'N/A'}, SLG: ${g.awayStats.teamSLG || 'N/A'}`,
    venue: g.venue,
    parkFactor: g.homeStats.parkFactor,
    vegasOULine: g.vegasOULine,
    homeOdds: g.homeOdds,
    awayOdds: g.awayOdds,
    simHomeWin: g.sim?.homeWinPct,
    simAwayWin: g.sim?.awayWinPct,
    simTotal: g.sim?.projectedTotal,
  }));

  const prompt = `You are an expert MLB betting analyst. Using these real MLB Stats API inputs and Monte Carlo simulation results, provide sharp 2-3 sentence reasoning for each game covering: key pitcher matchup angle, team offensive/defensive context, and the most actionable betting insight.

GAMES:
${JSON.stringify(summary, null, 2)}

Return ONLY a JSON array:
[{"matchup": "Away @ Home", "reasoning": "2-3 sentences", "commence_time": "e.g. 7:10 PM ET"}]
JSON only.`;

  try {
    const result = await httpsPost('api.anthropic.com', '/v1/messages',
      { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      { model: 'claude-sonnet-4-20250514', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }
    );
    const raw = result.content?.map(b => b.text || '').join('') || '';
    const clean = raw.replace(/```json|```/g, '').replace(/:\s*\+(\d)/g, ': $1').trim();
    try { return JSON.parse(clean); }
    catch(e) {
      const m = raw.match(/\[[\s\S]*\]/);
      return m ? JSON.parse(m[0].replace(/:\s*\+(\d)/g, ': $1')) : [];
    }
  } catch(e) {
    console.log('AI reasoning failed:', e.message);
    return [];
  }
}

// ─── Analyze Game ─────────────────────────────────────────────────────────────
function analyzeGame(game) {
  const sim = runMonteCarlo(game.homeStats, game.awayStats, 1000000);

  let pick, pickOdds, ourProb, impliedP, ev, kelly;
  const ho = game.homeOdds, ao = game.awayOdds;

  if (ho && ao) {
    const homeEV = (sim.homeWinPct / 100 * dec(ho) - 1) * 100;
    const awayEV = (sim.awayWinPct / 100 * dec(ao) - 1) * 100;
    if (homeEV >= awayEV) {
      pick = game.homeTeam; pickOdds = ho;
      ourProb = sim.homeWinPct / 100; impliedP = impliedProb(ho); ev = homeEV;
    } else {
      pick = game.awayTeam; pickOdds = ao;
      ourProb = sim.awayWinPct / 100; impliedP = impliedProb(ao); ev = awayEV;
    }
  } else {
    // No odds — pick sim favorite
    if (sim.homeWinPct >= sim.awayWinPct) {
      pick = game.homeTeam; pickOdds = -115; ourProb = sim.homeWinPct / 100;
    } else {
      pick = game.awayTeam; pickOdds = 105; ourProb = sim.awayWinPct / 100;
    }
    impliedP = impliedProb(pickOdds);
    ev = (ourProb * dec(pickOdds) - 1) * 100;
  }

  const d = dec(pickOdds);
  kelly = Math.max(0, Math.min(25, ((ourProb * d - 1) / (d - 1)) * 100));

  // O/U recommendation
  let ouPick = null, ouEdge = null;
  if (game.vegasOULine) {
    const edge = sim.projectedTotal - game.vegasOULine;
    if (Math.abs(edge) > 0.3) {
      ouPick = edge > 0 ? 'OVER' : 'UNDER';
      ouEdge = Math.abs(edge);
    }
  }

  return { ...game, sim, pick, pickOdds, ourProb, impliedP, ev, kelly, ouPick, ouEdge };
}

// ─── Email Builder ────────────────────────────────────────────────────────────
function evColor(ev) { return ev > 5 ? '#16a34a' : ev > 0 ? '#65a30d' : ev > -5 ? '#ca8a04' : '#dc2626'; }

function buildPicksEmail(analyzed, timeLabel, bankroll = 1000) {
  const sorted = [...analyzed].sort((a, b) => b.ev - a.ev);
  const best = sorted[0];
  const posEV = sorted.filter(g => g.ev > 0).length;
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York'
  });

  const cards = sorted.map((g, i) => {
    const ec = evColor(g.ev);
    const isBest = i === 0;
    const bet = ((g.kelly / 100) * bankroll).toFixed(0);
    const evSign = g.ev > 0 ? '+' : '';
    const s = g.sim;
    const gameTime = g.commence_time || (g.gameTime ? new Date(g.gameTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET' : 'TBD');

    const ouRow = g.vegasOULine ? `
      <tr><td style="padding:5px 0;color:#6b7280;font-size:12px">O/U vs Vegas ${g.vegasOULine}</td>
      <td style="padding:5px 0;font-size:12px;text-align:right;font-weight:600;color:${g.ouPick === 'OVER' ? '#16a34a' : g.ouPick === 'UNDER' ? '#dc2626' : '#374151'}">
        ${g.ouPick ? `${g.ouPick} edge: ${g.ouEdge?.toFixed(1)} runs` : 'Neutral'}</td></tr>` : '';

    const statsNote = g.homeStats.gamesPlayed < 3
      ? `<div style="background:#fef3c7;border-radius:6px;padding:8px 12px;font-size:11px;color:#92400e;margin-bottom:10px">⚠ Early season — limited stat sample (${g.homeStats.gamesPlayed} games). Simulation uses league averages where needed.</div>`
      : '';

    return `
<div style="background:${isBest ? '#f0fdf4' : '#fff'};border:1px solid ${isBest ? '#86efac' : '#e5e7eb'};border-radius:12px;padding:20px;margin-bottom:16px">
  ${isBest ? '<div style="background:#16a34a;color:#fff;font-size:11px;font-weight:700;padding:2px 12px;border-radius:4px;display:inline-block;margin-bottom:10px;letter-spacing:1px">⚡ BEST VALUE</div>' : ''}
  ${statsNote}

  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px">
    <div>
      <div style="font-size:16px;font-weight:700;color:#111827">${g.awayTeam} @ ${g.homeTeam}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px">${gameTime} · ${g.venue || ''}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px">
        ⚾ ${g.awayPitcherName} (${g.awayStats.starterERA?.toFixed(2) || '—'} ERA) vs ${g.homePitcherName} (${g.homeStats.starterERA?.toFixed(2) || '—'} ERA)
      </div>
    </div>
    <span style="background:${ec}18;border:1px solid ${ec}44;color:${ec};border-radius:4px;padding:3px 10px;font-size:13px;font-weight:700">${evSign}${g.ev.toFixed(1)}% EV</span>
  </div>

  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Pick</div>
      <div style="font-size:14px;font-weight:700;color:${ec}">${g.pick}</div>
      <div style="font-size:12px;color:#6b7280">${fmtOdds(g.pickOdds)} · ${g.bookmaker || 'Est.'}</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Kelly Bet</div>
      <div style="font-size:14px;font-weight:700;color:#111827">$${bet}</div>
      <div style="font-size:12px;color:#6b7280">${g.kelly.toFixed(1)}% bankroll</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Sim Win Prob</div>
      <div style="font-size:14px;font-weight:700;color:#111827">${g.pick === g.homeTeam ? s.homeWinPct : s.awayWinPct}%</div>
      <div style="font-size:12px;color:#6b7280">Implied: ${(g.impliedP * 100).toFixed(1)}%</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">CI (95%)</div>
      <div style="font-size:14px;font-weight:700;color:#111827">${s.ciLow}–${s.ciHigh}%</div>
      <div style="font-size:12px;color:#6b7280">Confidence range</div>
    </div>
  </div>

  <div style="background:#eff6ff;border-radius:8px;padding:14px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">
      🎲 1,000,000 Monte Carlo Simulations · MLB Stats API inputs
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr>
        <td style="padding:4px 0;color:#374151;width:55%">${g.homeTeam} win probability</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${s.homeWinPct}%</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#374151">${g.awayTeam} win probability</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${s.awayWinPct}%</td>
      </tr>
      <tr><td colspan="2"><hr style="border:none;border-top:1px solid #dbeafe;margin:6px 0"></td></tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280">Projected total runs</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${s.projectedTotal}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280">F5 projected total</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${s.projectedF5Total}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280">F5 winner</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${g.homeTeam} ${s.homeF5WinPct}% · ${g.awayTeam} ${s.awayF5WinPct}%</td>
      </tr>
      ${ouRow}
      <tr><td colspan="2"><hr style="border:none;border-top:1px solid #dbeafe;margin:6px 0"></td></tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280">Proj. strikeouts (combined)</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${s.projectedK} K</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280">Proj. home runs (combined)</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${s.projectedHR} HR</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280">Proj. hits (combined)</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">${s.projectedHits} H</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280">Over / Under %</td>
        <td style="padding:4px 0;font-weight:700;text-align:right">Over ${s.overPct}% · Under ${s.underPct}%</td>
      </tr>
    </table>
    <div style="margin-top:10px;font-size:10px;color:#93c5fd">
      Inputs: Starter ERA ${g.awayStats.starterERA?.toFixed(2) || '—'} / ${g.homeStats.starterERA?.toFixed(2) || '—'} · 
      Bullpen ERA ${g.awayStats.bullpenERA?.toFixed(2) || '—'} / ${g.homeStats.bullpenERA?.toFixed(2) || '—'} · 
      Park factor ${g.homeStats.parkFactor?.toFixed(2)}
    </div>
  </div>

  <div style="background:#f9fafb;border-radius:6px;padding:10px 14px;border-left:3px solid #16a34a;font-size:13px;color:#6b7280;line-height:1.6">
    <span style="color:#16a34a;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Analysis · </span>
    ${g.reasoning || 'Simulation-based recommendation.'}
  </div>
</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;margin:0;padding:20px">
<div style="max-width:680px;margin:0 auto">

  <div style="background:linear-gradient(135deg,#14532d,#16a34a);border-radius:14px;padding:28px;margin-bottom:20px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">⚾</div>
    <div style="color:#fff;font-size:22px;font-weight:700">MLB Value Picks</div>
    <div style="color:#bbf7d0;font-size:13px;margin-top:6px">${timeLabel} · ${today}</div>
    <div style="color:#86efac;font-size:11px;margin-top:4px">1M Monte Carlo simulations · MLB Stats API · The Odds API</div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
    ${[['Games', sorted.length], ['+ EV', posEV], ['Best EV', best ? (best.ev > 0 ? '+' : '') + best.ev.toFixed(1) + '%' : '—'], ['Top Bet', best ? '$' + ((best.kelly / 100) * bankroll).toFixed(0) : '—']].map(([l, v]) =>
      `<div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
        <div style="font-size:22px;font-weight:700;color:#16a34a">${v}</div>
        <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">${l}</div>
      </div>`
    ).join('')}
  </div>

  ${cards}

  <div style="text-align:center;color:#9ca3af;font-size:11px;padding:16px;line-height:1.8">
    Powered by MLB Stats API · Poisson run distribution model · Kelly capped at 25%<br>
    For informational use only · Bet responsibly
  </div>
</div>
</body>
</html>`;
}

// ─── Save + Send ──────────────────────────────────────────────────────────────
function savePicks(analyzed, dataDir) {
  const date = todayStr();
  const file = path.join(dataDir, `picks-${date}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { date, games: [], sent_at: [] };
  existing.games = analyzed.map(g => ({
    home_team: g.homeTeam, away_team: g.awayTeam,
    commence_time: g.commence_time || g.gameTime,
    pick: g.pick, pick_odds: g.pickOdds, ev: g.ev, kelly: g.kelly,
    sim_home_win_pct: g.sim?.homeWinPct, sim_away_win_pct: g.sim?.awayWinPct,
  }));
  existing.sent_at = [...(existing.sent_at || []), new Date().toISOString()];
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
  console.log('Picks saved.');
}

async function sendEmail(to, from, pass, subject, html) {
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
  await t.sendMail({ from, to, subject, html });
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
  console.log(`Running ${timeLabel} picks — MLB Stats API + Monte Carlo...`);

  // 1. Fetch schedule + detailed stats from MLB API
  console.log('Fetching MLB schedule...');
  const schedule = await fetchMLBSchedule();
  console.log(`${schedule.length} games on schedule`);

  // 2. Fetch odds
  const oddsData = await fetchOdds(ODDS_API_KEY);
  console.log(`Odds API: ${oddsData.length} games`);

  // 3. Build game data with real pitcher + team stats
  console.log('Fetching pitcher & team stats from MLB Stats API...');
  const games = await buildGameData(schedule);

  // 4. Attach odds to each game
  for (const g of games) {
    const odds = matchOdds(g, oddsData);
    g.homeOdds = odds.homeOdds;
    g.awayOdds = odds.awayOdds;
    g.vegasOULine = odds.ouLine;
    g.bookmaker = odds.bookmaker;
  }

  // 5. Run Monte Carlo simulations
  console.log(`Running 1,000,000 simulations per game for ${games.length} games...`);
  const analyzed = games.map(analyzeGame).sort((a, b) => b.ev - a.ev);

  // 6. Get AI reasoning
  console.log('Getting AI reasoning...');
  const reasoning = await getAIReasoning(analyzed, ANTHROPIC_API_KEY);
  for (const g of analyzed) {
    const r = reasoning.find(r => r.matchup?.includes(g.awayTeam?.split(' ').pop()) || r.matchup?.includes(g.homeTeam?.split(' ').pop()));
    g.reasoning = r?.reasoning || '';
    g.commence_time = r?.commence_time || g.commence_time;
  }

  // 7. Save + send
  savePicks(analyzed, dataDir);
  const html = buildPicksEmail(analyzed, timeLabel);
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  await sendEmail(EMAIL_TO, GMAIL_USER, GMAIL_APP_PASSWORD,
    `⚾ MLB Picks — ${timeLabel} · ${date} · ${analyzed.filter(g => g.ev > 0).length} +EV games`, html);
  console.log('Done!');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
