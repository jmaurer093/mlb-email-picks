const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./database');

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────
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

function httpsPost(hostname, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path: urlPath, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', chunk => d += chunk);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: POST ${hostname}${urlPath} — ${d.slice(0, 300)}`));
          }
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
  return 'Noon';
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

// ─── Platoon Adjustment ───────────────────────────────────────────────────────
function getPlatoonMultiplier(pitcherHand, teamOBP, teamSLG) {
  const obp = safeNum(teamOBP, 0.320);
  const slg = safeNum(teamSLG, 0.400);
  const denom = obp + slg || 1;
  const vsAdv = { obp: 1.055, slg: 1.08 };   // vs opposite-hand pitcher
  const vsSame = { obp: 0.950, slg: 0.920 };  // vs same-hand pitcher
  // ~60% of MLB lineups are right-handed batters.
  // vs LHP: righties (~60%) have platoon advantage, lefties (~40%) don't
  // vs RHP: lefties (~40%) have platoon advantage, righties (~60%) don't
  const advPct = pitcherHand === 'L' ? 0.60 : 0.40;
  const samePct = 1.0 - advPct;
  const adjOBP = obp * (advPct * vsAdv.obp + samePct * vsSame.obp);
  const adjSLG = slg * (advPct * vsAdv.slg + samePct * vsSame.slg);
  return (adjOBP + adjSLG) / denom;
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

function runMonteCarlo(homeStats, awayStats, weather, umpFactor = 1.0, N = 10000000) {
  const lgAvgRPG = 4.5;
  const lgAvgHPG = 8.5;
  const lgAvgHRPG = 1.1;
  const lgAvgKPG = 8.5;
  const lgAvgERA = 4.20;
  const lgAvgOBP = 0.320;
  const lgAvgSLG = 0.400;

  // ─── PITCHING-FIRST RUN MODEL ─────────────────────────────────────────────
  // Starter covers ~6.0 innings (up from 5.5) — emphasizes starter quality
  // Bullpen covers ~3.0 innings, with fatigue multiplier on top
  const starterIP = 6.0;
  const bullpenIP = 3.0;

  // Pitcher quality is the PRIMARY input. Use ERA² scaling so elite pitchers
  // (ERA < 3.00) suppress runs more aggressively, and bad pitchers (ERA > 5.00)
  // give up more — this matches reality where pitcher quality is non-linear.
  const homeStarterRunRate = safeNum(homeStats.starterERA, lgAvgERA) / 9;
  const awayStarterRunRate = safeNum(awayStats.starterERA, lgAvgERA) / 9;

  // Apply bullpen fatigue (1.00–1.18 multiplier based on recent IP)
  const homeBpFatigue = safeNum(homeStats.bullpenFatigue, 1.0);
  const awayBpFatigue = safeNum(awayStats.bullpenFatigue, 1.0);
  const homeBullpenRate = (safeNum(homeStats.bullpenERA, 4.30) / 9) * homeBpFatigue;
  const awayBullpenRate = (safeNum(awayStats.bullpenERA, 4.30) / 9) * awayBpFatigue;

  // Pitcher rest day adjustment — short rest = inflated runs, long rest = slight bump
  const restAdj = (days) => {
    if (days === null || days === undefined) return 1.0;
    if (days <= 3) return 1.06;   // short rest, fatigued
    if (days === 4) return 1.00;  // standard rest
    if (days === 5) return 0.99;  // optimal
    if (days >= 6 && days <= 10) return 1.00;
    if (days > 10) return 1.04;   // rust factor
    return 1.0;
  };
  const homeStarterRestAdj = restAdj(homeStats.starterRestDays);
  const awayStarterRestAdj = restAdj(awayStats.starterRestDays);

  // Pitcher workload trend — heavy recent pitch counts indicate fatigue building
  const workloadAdj = (avgPitches) => {
    if (!avgPitches) return 1.0;
    if (avgPitches >= 105) return 1.04; // overworked
    if (avgPitches >= 95) return 1.01;
    if (avgPitches < 80) return 0.98;   // light workload, fresh
    return 1.0;
  };
  const homeStarterWorkload = workloadAdj(homeStats.starterAvgPitches);
  const awayStarterWorkload = workloadAdj(awayStats.starterAvgPitches);

  // Combined pitching expected runs allowed
  const homeAllowedPerGame =
    homeStarterRunRate * starterIP * homeStarterRestAdj * homeStarterWorkload +
    homeBullpenRate * bullpenIP;
  const awayAllowedPerGame =
    awayStarterRunRate * starterIP * awayStarterRestAdj * awayStarterWorkload +
    awayBullpenRate * bullpenIP;

  // ─── OFFENSE — secondary input, dampened ──────────────────────────────────
  // Sub-linear scaling (^0.7) caps offense's ability to override pitcher dominance.
  // A team scoring 5.0 RPG vs league 4.5 (factor 1.11) becomes 1.077 after damping —
  // meaningful but no longer outweighs a strong starter.
  const homeRPG = safeNum(homeStats.teamRPG, lgAvgRPG);
  const awayRPG = safeNum(awayStats.teamRPG, lgAvgRPG);
  const homeOffFactor = Math.pow(homeRPG / lgAvgRPG, 0.7);
  const awayOffFactor = Math.pow(awayRPG / lgAvgRPG, 0.7);

  // Recent form (last 14 days) — blended in at 25% to capture momentum without
  // overweighting small samples.
  const homeRecent = safeNum(homeStats.recent14RPG, homeRPG);
  const awayRecent = safeNum(awayStats.recent14RPG, awayRPG);
  const homeFormBlend = homeRPG * 0.75 + homeRecent * 0.25;
  const awayFormBlend = awayRPG * 0.75 + awayRecent * 0.25;
  const homeFormFactor = Math.pow(homeFormBlend / lgAvgRPG, 0.7);
  const awayFormFactor = Math.pow(awayFormBlend / lgAvgRPG, 0.7);

  // Day-after-night fatigue — well-documented ~3-4% offensive suppression
  const homeDanFactor = homeStats.dayAfterNight ? 0.965 : 1.0;
  const awayDanFactor = awayStats.dayAfterNight ? 0.965 : 1.0;

  // Park factor (venue effect — both teams)
  const parkFactor = safeNum(homeStats.parkFactor, 1.0);

  // Platoon adjustment (handedness)
  const homePlatoon = getPlatoonMultiplier(awayStats.starterThrows || 'R', homeStats.teamOBP, homeStats.teamSLG);
  const awayPlatoon = getPlatoonMultiplier(homeStats.starterThrows || 'R', awayStats.teamOBP, awayStats.teamSLG);

  // Weather
  const windSpeed = weather?.windSpeed || 8;
  const windDir = weather?.windDir || 'neutral';
  const windFactor = windDir === 'out' && windSpeed > 10
    ? 1.0 + Math.min(0.12, (windSpeed - 10) * 0.008)
    : windDir === 'in' && windSpeed > 10
      ? 1.0 - Math.min(0.10, (windSpeed - 10) * 0.007)
      : 1.0;
  const temp = weather?.temp || 72;
  const tempFactor = temp < 50 ? 0.94 : temp < 60 ? 0.97 : temp > 85 ? 1.03 : 1.0;

  // ─── FINAL LAMBDAS ────────────────────────────────────────────────────────
  // Pitching expected runs (against) is the BASE. Offense factors adjust on top.
  const homeLambda =
    awayAllowedPerGame *           // opposing pitching is primary
    homeFormFactor *               // home offense (dampened, recency-blended)
    homePlatoon *                  // handedness
    homeDanFactor *                // day-after-night fatigue
    parkFactor * windFactor * tempFactor * umpFactor;

  const awayLambda =
    homeAllowedPerGame *
    awayFormFactor *
    awayPlatoon *
    awayDanFactor *
    parkFactor * windFactor * tempFactor * umpFactor;

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
  // For half-run lines (8.5): over = ceil(8.5) = 9+. Correct, no push possible.
  // For integer lines (9.0): over = 10+, push = exactly 9. ceil(9) = 9 would wrongly include push.
  const overStart = suggestedLine % 1 === 0 ? suggestedLine + 1 : Math.ceil(suggestedLine);
  for (let r = overStart; r < 35; r++) overCount += runDist[r];
  // Push count only exists on integer lines
  const pushCount = suggestedLine % 1 === 0 ? (runDist[suggestedLine] || 0) : 0;
  const underCount = N - overCount - pushCount;

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
    underPct: +(underCount / N * 100).toFixed(1),
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
      `https://${MLB_BASE}/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher(stats),team,linescore,broadcasts,venue,officials`
    );
    return data.dates?.[0]?.games || [];
  } catch(e) {
    console.log('MLB schedule fetch failed:', e.message);
    return [];
  }
}

async function fetchPitcherStats(personId, gameDate = null) {
  if (!personId) return {};
  try {
    const [season, last30, info, gameLog] = await Promise.all([
      httpsGet(`https://${MLB_BASE}/api/v1/people/${personId}/stats?stats=season&group=pitching&season=2026`),
      httpsGet(`https://${MLB_BASE}/api/v1/people/${personId}/stats?stats=lastXGames&group=pitching&season=2026&limit=7`),
      httpsGet(`https://${MLB_BASE}/api/v1/people/${personId}`),
      httpsGet(`https://${MLB_BASE}/api/v1/people/${personId}/stats?stats=gameLog&group=pitching&season=2026`).catch(() => ({}))
    ]);
    const s = season.stats?.[0]?.splits?.[0]?.stat || {};
    const r = last30.stats?.[0]?.splits?.[0]?.stat || {};
    const hand = info.people?.[0]?.pitchHand?.code || 'R';
    // FIP estimate from K, BB, HR rates (MLB API does not return xFIP/SIERA)
    const k9 = safeNum(s.strikeoutsPer9Inn, null);
    const bb9 = safeNum(s.walksPer9Inn, null);
    const hr9 = safeNum(s.homeRunsPer9, null);
    const era = safeNum(s.era, null);
    let estFIP = null;
    if (k9 !== null && bb9 !== null && hr9 !== null) {
      estFIP = +((13 * hr9 + 3 * bb9 - 2 * k9 + 3.10 * 9) / 9).toFixed(2);
    }
    const bestERA = estFIP ?? era;

    // Rest days + recent pitch count from game log
    let restDays = null;
    let avgPitchCount = null;
    let lastStartIP = null;
    const splits = gameLog.stats?.[0]?.splits || [];
    if (splits.length > 0 && gameDate) {
      // Find most recent start before today
      const sorted = splits
        .filter(g => g.stat?.gamesStarted >= 1 || parseFloat(g.stat?.inningsPitched || '0') >= 3)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      if (sorted.length > 0) {
        const lastDate = sorted[0].date;
        if (lastDate) {
          const ms = new Date(gameDate).getTime() - new Date(lastDate).getTime();
          restDays = Math.floor(ms / (1000 * 60 * 60 * 24));
        }
        lastStartIP = parseFloat(sorted[0].stat?.inningsPitched || '0');
      }
      // Average pitches across last 3 starts (proxy for workload trend)
      const last3 = sorted.slice(0, 3);
      const pitches = last3.map(g => safeNum(g.stat?.numberOfPitches, 0)).filter(p => p > 0);
      if (pitches.length > 0) avgPitchCount = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    }

    return {
      era,
      bestERA,
      estFIP,
      whip: safeNum(s.whip, null),
      k9,
      bb9,
      hr9,
      ip: safeNum(s.inningsPitched, null),
      recentERA: safeNum(r.era, null),
      recentWHIP: safeNum(r.whip, null),
      throws: hand,
      restDays,
      avgPitchCount,
      lastStartIP,
    };
  } catch(e) {
    return {};
  }
}

async function fetchTeamStats(teamId) {
  if (!teamId) return {};
  try {
    const [hitting, pitching, splits, lastX] = await Promise.all([
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=2026`),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=2026`),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=statSplits&sitCodes=h,a&group=hitting&season=2026`).catch(() => ({})),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=lastXGames&group=hitting&season=2026&limit=14`).catch(() => ({}))
    ]);
    const h = hitting.stats?.[0]?.splits?.[0]?.stat || {};
    const p = pitching.stats?.[0]?.splits?.[0]?.stat || {};
    const gamesPlayed = safeNum(h.gamesPlayed, 1);

    // Parse home/away splits
    const splitArr = splits.stats?.[0]?.splits || [];
    const homeSplit = splitArr.find(s => s.split?.code === 'h')?.stat || {};
    const awaySplit = splitArr.find(s => s.split?.code === 'a')?.stat || {};
    const homeGP = safeNum(homeSplit.gamesPlayed, 1);
    const awayGP = safeNum(awaySplit.gamesPlayed, 1);

    // Last 14 days form
    const recent = lastX.stats?.[0]?.splits?.[0]?.stat || {};
    const recentGP = safeNum(recent.gamesPlayed, 1);

    return {
      runsPerGame: safeNum(h.runs, 0) / gamesPlayed,
      hitsPerGame: safeNum(h.hits, 0) / gamesPlayed,
      hrPerGame: safeNum(h.homeRuns, 0) / gamesPlayed,
      obp: safeNum(h.obp, null),
      slg: safeNum(h.slg, null),
      avg: safeNum(h.avg, null),
      // Home/away offensive splits
      homeRPG: safeNum(homeSplit.runs, 0) / homeGP,
      homeOBP: safeNum(homeSplit.obp, null),
      homeSLG: safeNum(homeSplit.slg, null),
      awayRPG: safeNum(awaySplit.runs, 0) / awayGP,
      awayOBP: safeNum(awaySplit.obp, null),
      awaySLG: safeNum(awaySplit.slg, null),
      // Last 14 days
      recent14RPG: safeNum(recent.runs, 0) / recentGP,
      recent14OBP: safeNum(recent.obp, null),
      recent14SLG: safeNum(recent.slg, null),
      // Bullpen ERA — team pitching ERA + 0.30 (relievers run higher than full staff)
      bullpenERA: (safeNum(p.era, 4.00)) + 0.30,
      bullpenK9: safeNum(p.strikeoutsPer9Inn, 8.5),
      gamesPlayed,
    };
  } catch(e) {
    return {};
  }
}

// ─── Lineup Fetcher (today's actual batting order) ────────────────────────────
async function fetchLineup(gamePk) {
  if (!gamePk) return { home: [], away: [] };
  try {
    const data = await httpsGet(`https://${MLB_BASE}/api/v1/game/${gamePk}/boxscore`);
    const homeOrder = data.teams?.home?.battingOrder || [];
    const awayOrder = data.teams?.away?.battingOrder || [];
    return { home: homeOrder, away: awayOrder };
  } catch(e) {
    return { home: [], away: [] };
  }
}

async function fetchLineupStats(batterIds, pitcherHand = 'R') {
  if (!batterIds || batterIds.length === 0) return null;
  try {
    // Fetch top 5 hitters' season + platoon split stats in parallel
    // (top-5 captures most lineup variance; weaker hitters add noise)
    const top5 = batterIds.slice(0, 5);
    const sitCode = pitcherHand === 'L' ? 'vl' : 'vr';
    const results = await Promise.all(top5.map(id =>
      Promise.all([
        httpsGet(`https://${MLB_BASE}/api/v1/people/${id}/stats?stats=season&group=hitting&season=2026`).catch(() => ({})),
        httpsGet(`https://${MLB_BASE}/api/v1/people/${id}/stats?stats=statSplits&sitCodes=${sitCode}&group=hitting&season=2026`).catch(() => ({}))
      ])
    ));
    let totalOBP = 0, totalSLG = 0, count = 0;
    let platoonOBP = 0, platoonSLG = 0, platoonCount = 0;
    for (const [season, splits] of results) {
      const s = season.stats?.[0]?.splits?.[0]?.stat || {};
      const obp = parseFloat(s.obp);
      const slg = parseFloat(s.slg);
      if (!isNaN(obp) && !isNaN(slg)) {
        totalOBP += obp;
        totalSLG += slg;
        count++;
      }
      const sp = splits.stats?.[0]?.splits?.[0]?.stat || {};
      const pObp = parseFloat(sp.obp);
      const pSlg = parseFloat(sp.slg);
      if (!isNaN(pObp) && !isNaN(pSlg)) {
        platoonOBP += pObp;
        platoonSLG += pSlg;
        platoonCount++;
      }
    }
    if (count === 0) return null;
    return {
      lineupOBP: totalOBP / count,
      lineupSLG: totalSLG / count,
      lineupVsPitcherOBP: platoonCount > 0 ? platoonOBP / platoonCount : null,
      lineupVsPitcherSLG: platoonCount > 0 ? platoonSLG / platoonCount : null,
      battersFound: count,
    };
  } catch(e) {
    return null;
  }
}

// ─── Bullpen Fatigue (innings thrown by relievers in last 2 days) ────────────
async function fetchBullpenFatigue(teamId, gameDate) {
  if (!teamId || !gameDate) return { fatigueMultiplier: 1.0, recentBullpenIP: 0 };
  try {
    const today = new Date(gameDate);
    const start = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sched = await httpsGet(
      `https://${MLB_BASE}/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}&hydrate=probablePitcher`
    );
    const games = (sched.dates || []).flatMap(d => d.games || []);
    let totalReliefIP = 0;
    let priorGameTime = null;
    for (const g of games) {
      if (g.status?.abstractGameState !== 'Final') continue;
      // Track the most recent prior game time for day-after-night detection
      if (!priorGameTime || g.gameDate > priorGameTime) priorGameTime = g.gameDate;
      try {
        const box = await httpsGet(`https://${MLB_BASE}/api/v1/game/${g.gamePk}/boxscore`);
        const isHome = box.teams?.home?.team?.id === teamId;
        const teamBox = isHome ? box.teams.home : box.teams.away;
        const pitcherIds = teamBox?.pitchers || [];
        // First pitcher = starter, rest = relievers
        for (let i = 1; i < pitcherIds.length; i++) {
          const pid = pitcherIds[i];
          const pStat = teamBox.players?.[`ID${pid}`]?.stats?.pitching;
          if (pStat?.inningsPitched) {
            totalReliefIP += parseFloat(pStat.inningsPitched);
          }
        }
      } catch(e) { /* skip this game's box */ }
    }
    // Fatigue scale: <3 IP = fresh, 3-5 IP = mild, 5-8 IP = tired, 8+ IP = exhausted
    let fatigueMultiplier = 1.0;
    if (totalReliefIP >= 8) fatigueMultiplier = 1.18;
    else if (totalReliefIP >= 5) fatigueMultiplier = 1.10;
    else if (totalReliefIP >= 3) fatigueMultiplier = 1.04;
    return { fatigueMultiplier, recentBullpenIP: totalReliefIP, priorGameTime };
  } catch(e) {
    return { fatigueMultiplier: 1.0, recentBullpenIP: 0, priorGameTime: null };
  }
}

async function fetchVenueInfo(venueId) {
  // Park factors — all 30 MLB venues (approximate 2025 run-scoring environment)
  const parkFactors = {
    2392: 1.15, // Coors Field (COL)
    2395: 1.08, // Great American Ball Park (CIN)
    4169: 1.06, // Fenway Park (BOS)
    3313: 1.06, // Fenway alt ID
    2394: 1.05, // Wrigley Field (CHC)
    32:   1.04, // Yankee Stadium (NYY)
    4705: 1.03, // Globe Life Field (TEX)
    5:    1.03, // Guaranteed Rate Field (CWS)
    2500: 1.02, // Comerica Park (DET)
    15:   1.02, // Truist Park (ATL)
    2397: 1.01, // PNC Park (PIT)
    2396: 1.01, // American Family Field (MIL)
    4140: 1.01, // Camden Yards (BAL)
    3289: 1.00, // Busch Stadium (STL)
    2507: 1.00, // Kauffman Stadium (KC)
    2680: 1.00, // Citizens Bank Park (PHI)
    3312: 0.99, // Citi Field (NYM)
    4:    0.99, // Progressive Field (CLE)
    2889: 0.98, // Target Field (MIN)
    17:   0.98, // Chase Field (ARI)
    2536: 0.98, // Rogers Centre (TOR)
    2518: 0.97, // Minute Maid Park (HOU)
    2393: 0.97, // Petco Park (SD)
    680:  0.96, // Tropicana Field (TB)
    10:   0.96, // loanDepot Park (MIA)
    3309: 0.95, // Oracle Park (SF)
    2681: 0.94, // T-Mobile Park (SEA)
    2602: 0.93, // Dodger Stadium (LAD)
    19:   0.96, // Oakland Coliseum (OAK)
  };
  return { parkFactor: parkFactors[venueId] || 1.0 };
}

// ─── Umpire Run-Scoring Factors ──────────────────────────────────────────────
// Home plate umpire zone size directly impacts run scoring. Wider zone = fewer
// walks + more pitcher-friendly counts → fewer runs. Tight zone = opposite.
// Factors are run-scoring multipliers relative to league average (1.00 = neutral).
const UMPIRE_FACTORS = {
  // Over umpires — historically bigger zones, more runs
  "Hunter Wendelstedt": 1.052,
  "Lance Barksdale": 1.048,
  "Mark Ripperger": 1.041,
  "Dan Iassogna": 1.037,
  "Bill Miller": 1.034,
  "Mike Estabrook": 1.031,
  "Paul Nauert": 1.028,
  "Jordan Baker": 1.025,
  "Doug Eddings": 1.023,
  "Alfonso Marquez": 1.020,
  "Chad Whitson": 1.018,
  "Jansen Visconti": 1.015,
  // Under umpires — tighter zones, fewer runs
  "Rob Drake": 0.962,
  "Marty Foster": 0.968,
  "Phil Cuzzi": 0.971,
  "Brian Gorman": 0.974,
  "Sean Barber": 0.979,
  "Laz Diaz": 0.982,
  "Pat Hoberg": 0.985,
  "David Rackley": 0.986,
  "Nic Lentz": 0.988,
  "John Tumpane": 0.990,
  "Tripp Gibson": 0.992,
  "Adam Hamari": 0.993,
};
function getUmpireFactor(name) {
  return UMPIRE_FACTORS[name] || 1.0;
}

// ─── Weather Fetch (open-meteo, no API key) ───────────────────────────────────
const VENUE_COORDS = {
  // All 30 MLB venues — venue IDs from statsapi.mlb.com
  2392: [39.756, -104.994],  // Coors Field (COL)
  2395: [39.097, -84.507],   // Great American Ball Park (CIN)
  4169: [42.346, -71.098],   // Fenway Park (BOS)
  2394: [41.948, -87.655],   // Wrigley Field (CHC)
  32:   [40.829, -73.926],   // Yankee Stadium (NYY)
  4705: [32.751, -97.083],   // Globe Life Field (TEX) — retractable roof
  2393: [32.707, -117.157],  // Petco Park (SD)
  680:  [27.768, -82.653],   // Tropicana Field (TB) — dome
  3309: [37.778, -122.389],  // Oracle Park (SF)
  2681: [47.591, -122.333],  // T-Mobile Park (SEA) — retractable roof
  2602: [34.074, -118.240],  // Dodger Stadium (LAD)
  5:    [41.830, -87.634],   // Guaranteed Rate Field (CWS)
  4:    [41.495, -81.685],   // Progressive Field (CLE)
  2500: [42.339, -83.049],   // Comerica Park (DET)
  4140: [39.284, -76.621],   // Camden Yards (BAL)
  3289: [38.623, -90.193],   // Busch Stadium (STL)
  2889: [44.982, -93.278],   // Target Field (MIN)
  2680: [39.906, -75.166],   // Citizens Bank Park (PHI)
  3312: [40.757, -73.846],   // Citi Field (NYM)
  3313: [42.346, -71.098],   // Fenway alternate ID (BOS)
  2392: [39.756, -104.994],  // Coors alternate listing
  17:   [33.445, -112.067],  // Chase Field (ARI) — retractable roof
  15:   [33.891, -84.468],   // Truist Park (ATL)
  14:   [39.284, -76.622],   // Camden Yards alt
  2518: [29.757, -95.355],   // Minute Maid Park (HOU) — retractable roof
  2507: [39.097, -94.480],   // Kauffman Stadium (KC)
  1:    [34.074, -118.240],  // Dodger Stadium alt
  2536: [43.641, -79.389],   // Rogers Centre (TOR) — retractable roof
  3176: [47.591, -122.333],  // T-Mobile alt
  10:   [25.778, -80.220],   // loanDepot Park (MIA) — retractable roof
  2397: [40.447, -80.006],   // PNC Park (PIT)
  2396: [43.028, -87.971],   // American Family Field (MIL) — retractable roof
  19:   [37.752, -122.201],  // Oakland Coliseum (OAK)
  31:   [38.623, -90.193],   // Busch alt
  2392: [39.756, -104.994],  // Coors
};

async function fetchWeather(venueId, gameDate) {
  const coords = VENUE_COORDS[venueId];
  if (!coords) return { windSpeed: 8, windDir: 'neutral', temp: 72 };
  try {
    const [lat, lon] = coords;
    const date = gameDate ? gameDate.split('T')[0] : new Date().toISOString().split('T')[0];
    const data = await httpsGet(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m,temperature_2m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&start_date=${date}&end_date=${date}`
    );
    // Use ~7 PM game time = index 19 in hourly array
    const idx = 19;
    const windSpeed = safeNum(data.hourly?.wind_speed_10m?.[idx], 8);
    const windDeg = safeNum(data.hourly?.wind_direction_10m?.[idx], 180);
    const temp = safeNum(data.hourly?.temperature_2m?.[idx], 72);
    // Wind blowing out = roughly NW (270-360 or 0-90 at most outdoor parks facing home plate north)
    // Simplified: >15 mph wind = significant; direction approximated
    const windDir = windSpeed > 15
      ? (windDeg > 90 && windDeg < 270 ? 'in' : 'out')
      : 'neutral';
    return { windSpeed, windDir, temp };
  } catch(e) {
    return { windSpeed: 8, windDir: 'neutral', temp: 72 };
  }
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
    const gameDate = game.gameDate;

    // Extract home plate umpire
    const officials = game.officials || [];
    const homePlateUmpObj = officials.find(o =>
      o.officialType === 'Home Plate' ||
      o.officialType === 'Home Plate Umpire' ||
      o.jobCode === 'HP'
    );
    const homePlateUmp = homePlateUmpObj?.official?.fullName || null;
    const umpFactor = getUmpireFactor(homePlateUmp);

    console.log(`  Fetching stats for ${game.teams?.away?.team?.name} @ ${game.teams?.home?.team?.name}${homePlateUmp ? ` (HP: ${homePlateUmp})` : ''}...`);

    // Phase 1 — fetch core data (pitchers, teams, venue, lineup, bullpen fatigue)
    const [homePitcher, awayPitcher, homeTeam, awayTeam, venue, lineup, homeFatigue, awayFatigue] = await Promise.all([
      fetchPitcherStats(homePitcherId, gameDate),
      fetchPitcherStats(awayPitcherId, gameDate),
      fetchTeamStats(homeTeamId),
      fetchTeamStats(awayTeamId),
      fetchVenueInfo(venueId),
      fetchLineup(game.gamePk),
      fetchBullpenFatigue(homeTeamId, gameDate),
      fetchBullpenFatigue(awayTeamId, gameDate),
    ]);

    // Phase 2 — fetch lineup stats (depends on lineup IDs and opposing pitcher hand)
    const [homeLineupStats, awayLineupStats] = await Promise.all([
      fetchLineupStats(lineup.home, awayPitcher.throws || 'R'),
      fetchLineupStats(lineup.away, homePitcher.throws || 'R'),
    ]);

    // Weather (don't block game data on failure)
    const weather = await fetchWeather(venueId, gameDate).catch(() => ({ windSpeed: 8, windDir: 'neutral', temp: 72 }));

    // ERA priority: recent form > FIP > season ERA > league avg
    const homeStarterERA = homePitcher.recentERA ?? homePitcher.bestERA ?? homePitcher.era ?? 4.20;
    const awayStarterERA = awayPitcher.recentERA ?? awayPitcher.bestERA ?? awayPitcher.era ?? 4.20;

    // Day game after night game detection
    const dayAfterNight = (priorGameTime, currentGameTime) => {
      if (!priorGameTime || !currentGameTime) return false;
      const prior = new Date(priorGameTime);
      const current = new Date(currentGameTime);
      // Less than 18 hours between first pitch of yesterday's game and today's
      // AND today's game starts before 5 PM ET (14 PM local-ish UTC)
      const hoursBetween = (current - prior) / (1000 * 60 * 60);
      const isDayGame = current.getUTCHours() < 21; // before ~5 PM ET
      return hoursBetween < 18 && hoursBetween > 0 && isDayGame;
    };
    const homeDayAfterNight = dayAfterNight(homeFatigue.priorGameTime, gameDate);
    const awayDayAfterNight = dayAfterNight(awayFatigue.priorGameTime, gameDate);

    // Apply lineup OBP/SLG when available, otherwise fall back to team season avg
    const homeOBP = homeLineupStats?.lineupOBP ?? homeTeam.obp ?? null;
    const homeSLG = homeLineupStats?.lineupSLG ?? homeTeam.slg ?? null;
    const awayOBP = awayLineupStats?.lineupOBP ?? awayTeam.obp ?? null;
    const awaySLG = awayLineupStats?.lineupSLG ?? awayTeam.slg ?? null;

    // Use home/away splits when home/away splits are available
    const homeRPGAdjusted = homeTeam.homeRPG > 0 ? homeTeam.homeRPG : (homeTeam.runsPerGame ?? 4.5);
    const awayRPGAdjusted = awayTeam.awayRPG > 0 ? awayTeam.awayRPG : (awayTeam.runsPerGame ?? 4.5);

    results.push({
      gamePk: game.gamePk,
      homeTeam: game.teams?.home?.team?.name,
      awayTeam: game.teams?.away?.team?.name,
      homeTeamId,
      awayTeamId,
      venue: game.venue?.name,
      venueId,
      gameTime: gameDate,
      weather,
      homePlateUmp: homePlateUmp || 'TBD',
      umpFactor,
      homePitcherName: game.teams?.home?.probablePitcher?.fullName || 'TBD',
      awayPitcherName: game.teams?.away?.probablePitcher?.fullName || 'TBD',
      homeStats: {
        starterERA: homeStarterERA,
        starterSeasonERA: homePitcher.era,
        starterFIP: homePitcher.estFIP,
        starterK9: homePitcher.k9 ?? 8.5,
        starterWHIP: homePitcher.whip,
        starterBB9: homePitcher.bb9,
        starterThrows: homePitcher.throws || 'R',
        starterRestDays: homePitcher.restDays,
        starterAvgPitches: homePitcher.avgPitchCount,
        starterLastIP: homePitcher.lastStartIP,
        bullpenERA: homeTeam.bullpenERA ?? 4.30,
        bullpenK9: homeTeam.bullpenK9 ?? 8.5,
        bullpenFatigue: homeFatigue.fatigueMultiplier,
        recentBullpenIP: homeFatigue.recentBullpenIP,
        teamRPG: homeRPGAdjusted,
        teamHPG: homeTeam.hitsPerGame ?? 8.5,
        teamHRPG: homeTeam.hrPerGame ?? 1.1,
        teamOBP: homeOBP,
        teamSLG: homeSLG,
        teamAVG: homeTeam.avg,
        recent14RPG: homeTeam.recent14RPG,
        lineupOBP: homeLineupStats?.lineupOBP ?? null,
        lineupSLG: homeLineupStats?.lineupSLG ?? null,
        lineupBattersFound: homeLineupStats?.battersFound ?? 0,
        dayAfterNight: homeDayAfterNight,
        gamesPlayed: homeTeam.gamesPlayed ?? 0,
        parkFactor: venue.parkFactor,
      },
      awayStats: {
        starterERA: awayStarterERA,
        starterSeasonERA: awayPitcher.era,
        starterFIP: awayPitcher.estFIP,
        starterK9: awayPitcher.k9 ?? 8.5,
        starterWHIP: awayPitcher.whip,
        starterBB9: awayPitcher.bb9,
        starterThrows: awayPitcher.throws || 'R',
        starterRestDays: awayPitcher.restDays,
        starterAvgPitches: awayPitcher.avgPitchCount,
        starterLastIP: awayPitcher.lastStartIP,
        bullpenERA: awayTeam.bullpenERA ?? 4.30,
        bullpenK9: awayTeam.bullpenK9 ?? 8.5,
        bullpenFatigue: awayFatigue.fatigueMultiplier,
        recentBullpenIP: awayFatigue.recentBullpenIP,
        teamRPG: awayRPGAdjusted,
        teamHPG: awayTeam.hitsPerGame ?? 8.5,
        teamHRPG: awayTeam.hrPerGame ?? 1.1,
        teamOBP: awayOBP,
        teamSLG: awaySLG,
        teamAVG: awayTeam.avg,
        recent14RPG: awayTeam.recent14RPG,
        lineupOBP: awayLineupStats?.lineupOBP ?? null,
        lineupSLG: awayLineupStats?.lineupSLG ?? null,
        lineupBattersFound: awayLineupStats?.battersFound ?? 0,
        dayAfterNight: awayDayAfterNight,
        gamesPlayed: awayTeam.gamesPlayed ?? 0,
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
  // Try two-word match first (prevents "Red Sox" vs "White Sox" confusion)
  for (const o of oddsData) {
    const homeKey = game.homeTeam?.split(' ').slice(-2).join(' ').toLowerCase();
    const awayKey = game.awayTeam?.split(' ').slice(-2).join(' ').toLowerCase();
    const oHome = o.home_team?.toLowerCase() || '';
    const oAway = o.away_team?.toLowerCase() || '';
    if (oHome.includes(homeKey) && oAway.includes(awayKey)) {
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
  // Fallback: single last word, require BOTH match
  for (const o of oddsData) {
    const homeLast = game.homeTeam?.split(' ').pop()?.toLowerCase();
    const awayLast = game.awayTeam?.split(' ').pop()?.toLowerCase();
    const oHome = o.home_team?.toLowerCase() || '';
    const oAway = o.away_team?.toLowerCase() || '';
    if (homeLast && awayLast && oHome.includes(homeLast) && oAway.includes(awayLast)) {
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
    homePitcher: `${g.homePitcherName} (ERA: ${g.homeStats.starterERA?.toFixed(2)}, FIP: ${g.homeStats.starterFIP?.toFixed(2) || 'N/A'}, K/9: ${g.homeStats.starterK9?.toFixed(1)}, BB/9: ${g.homeStats.starterBB9?.toFixed(2) || 'N/A'}, WHIP: ${g.homeStats.starterWHIP?.toFixed(2) || 'N/A'}, Throws: ${g.homeStats.starterThrows || 'R'}, Rest: ${g.homeStats.starterRestDays ?? 'N/A'} days, Avg pitches L3: ${g.homeStats.starterAvgPitches?.toFixed(0) || 'N/A'})`,
    awayPitcher: `${g.awayPitcherName} (ERA: ${g.awayStats.starterERA?.toFixed(2)}, FIP: ${g.awayStats.starterFIP?.toFixed(2) || 'N/A'}, K/9: ${g.awayStats.starterK9?.toFixed(1)}, BB/9: ${g.awayStats.starterBB9?.toFixed(2) || 'N/A'}, WHIP: ${g.awayStats.starterWHIP?.toFixed(2) || 'N/A'}, Throws: ${g.awayStats.starterThrows || 'R'}, Rest: ${g.awayStats.starterRestDays ?? 'N/A'} days, Avg pitches L3: ${g.awayStats.starterAvgPitches?.toFixed(0) || 'N/A'})`,
    homeBullpen: `ERA: ${g.homeStats.bullpenERA?.toFixed(2)}, K/9: ${g.homeStats.bullpenK9?.toFixed(1)}, IP last 2 days: ${g.homeStats.recentBullpenIP?.toFixed(1) || '0'} (fatigue mult: ${g.homeStats.bullpenFatigue?.toFixed(2)}x)`,
    awayBullpen: `ERA: ${g.awayStats.bullpenERA?.toFixed(2)}, K/9: ${g.awayStats.bullpenK9?.toFixed(1)}, IP last 2 days: ${g.awayStats.recentBullpenIP?.toFixed(1) || '0'} (fatigue mult: ${g.awayStats.bullpenFatigue?.toFixed(2)}x)`,
    homeOffense: `RPG: ${g.homeStats.teamRPG?.toFixed(2)} (last 14d: ${g.homeStats.recent14RPG?.toFixed(2) || 'N/A'}), Lineup OBP/SLG: ${g.homeStats.lineupOBP?.toFixed(3) || 'N/A'}/${g.homeStats.lineupSLG?.toFixed(3) || 'N/A'} (${g.homeStats.lineupBattersFound || 0} of top 5 found)${g.homeStats.dayAfterNight ? ' [day game after night game]' : ''}`,
    awayOffense: `RPG: ${g.awayStats.teamRPG?.toFixed(2)} (last 14d: ${g.awayStats.recent14RPG?.toFixed(2) || 'N/A'}), Lineup OBP/SLG: ${g.awayStats.lineupOBP?.toFixed(3) || 'N/A'}/${g.awayStats.lineupSLG?.toFixed(3) || 'N/A'} (${g.awayStats.lineupBattersFound || 0} of top 5 found)${g.awayStats.dayAfterNight ? ' [day game after night game]' : ''}`,
    venue: g.venue,
    parkFactor: g.homeStats.parkFactor,
    homePlateUmp: g.homePlateUmp,
    umpFactor: g.umpFactor,
    weather: g.weather,
    vegasOULine: g.vegasOULine,
    homeOdds: g.homeOdds,
    awayOdds: g.awayOdds,
    simHomeWin: g.sim?.homeWinPct,
    simAwayWin: g.sim?.awayWinPct,
    simTotal: g.sim?.projectedTotal,
    evAboveThreshold: g.ev >= 4.5,
  }));

  const prompt = `You are an expert MLB betting analyst. Using real MLB Stats API inputs and 10-million-simulation Monte Carlo results, provide sharp 2-3 sentence reasoning for each game.

PITCHING IS THE PRIMARY FACTOR. Lead your reasoning with the starting pitcher matchup. Always reference: starter ERA/FIP/WHIP, K/BB rates, recent rest days, and any pitcher fatigue signals (high recent pitch counts, short rest, heavy bullpen usage). Mention bullpen fatigue when one team has thrown 5+ relief innings in the last 2 days. Cite handedness platoon edges only after pitching is established.

Model factors applied: starter quality (heavily weighted), bullpen ERA + recent-IP fatigue multiplier, pitcher rest days, recent pitch count workload, today's actual lineup OBP/SLG (top 5 hitters), home/away offensive splits, last-14-days form, day-after-night fatigue, handedness platoon, park factor, weather, home plate umpire run-scoring tendency, minimum +4.5% EV edge filter.

For each game cover: (1) PITCHING — starter vs starter matchup with key rate stats and any fatigue/rest concerns, (2) SECONDARY — bullpen depth/fatigue, lineup quality, weather/park/ump impact if significant, (3) actionable betting insight referencing sim probability vs Vegas implied odds.

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
// ─── Confidence scoring ──────────────────────────────────────────────────────
// Composite score combining: sim win probability, CI tightness, sample size,
// gap between our sim and Vegas implied. Higher = more certain about the winner.
function calcConfidenceScore(sim, ourProb, impliedP, gamesPlayed) {
  const winProb = ourProb * 100;
  // How far sim win% is from 50% — bigger gap = more conviction
  const convictionGap = Math.abs(winProb - 50);
  // CI tightness — tighter range = more reliable estimate
  const ciWidth = Math.abs(sim.ciHigh - sim.ciLow);
  const ciScore = Math.max(0, 10 - ciWidth);
  // Sample size penalty — early season stats are noisy
  const sampleScore = Math.min(10, gamesPlayed / 3);
  // Agreement between our sim and Vegas (if Vegas agrees, more confident)
  const vegasGap = Math.abs(ourProb - impliedP) * 100;
  const agreementScore = vegasGap < 5 ? 8 : vegasGap < 10 ? 4 : 0;
  // Composite: weighted sum
  return Math.min(99, Math.round(convictionGap * 1.5 + ciScore + sampleScore + agreementScore));
}

function analyzeGame(game) {
  const sim = runMonteCarlo(game.homeStats, game.awayStats, game.weather, game.umpFactor || 1.0);

  let pick, pickOdds, ourProb, impliedP, ev, kelly;
  const ho = game.homeOdds, ao = game.awayOdds;

  // Always pick the side the simulation favors most — we want winners, not value
  if (sim.homeWinPct >= sim.awayWinPct) {
    pick = game.homeTeam;
    pickOdds = ho || -115;
    ourProb = sim.homeWinPct / 100;
    impliedP = impliedProb(pickOdds);
  } else {
    pick = game.awayTeam;
    pickOdds = ao || 105;
    ourProb = sim.awayWinPct / 100;
    impliedP = impliedProb(pickOdds);
  }

  ev = (ourProb * dec(pickOdds) - 1) * 100;
  const d = dec(pickOdds);
  kelly = Math.max(0, Math.min(25, ((ourProb * d - 1) / (d - 1)) * 100));

  // Confidence score — the primary ranking metric
  const gamesPlayed = Math.min(game.homeStats.gamesPlayed || 0, game.awayStats.gamesPlayed || 0);
  const confidenceScore = calcConfidenceScore(sim, ourProb, impliedP, gamesPlayed);

  // O/U recommendation
  let ouPick = null, ouEdge = null;
  if (game.vegasOULine) {
    const edge = sim.projectedTotal - game.vegasOULine;
    if (Math.abs(edge) > 0.3) {
      ouPick = edge > 0 ? 'OVER' : 'UNDER';
      ouEdge = Math.abs(edge);
    }
  }

  return { ...game, sim, pick, pickOdds, ourProb, impliedP, ev, kelly, ouPick, ouEdge, confidenceScore };
}

// ─── Email Builder ────────────────────────────────────────────────────────────
function evColor(ev) { return ev > 5 ? '#16a34a' : ev > 0 ? '#65a30d' : ev > -5 ? '#ca8a04' : '#dc2626'; }

function buildPicksEmail(analyzed, timeLabel, bankroll = 1000) {
  // Sort by confidence score (highest certainty picks first), take top 5
  const sorted = [...analyzed]
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, 5);
  const best = sorted[0];
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
  ${isBest ? '<div style="background:#16a34a;color:#fff;font-size:11px;font-weight:700;padding:2px 12px;border-radius:4px;display:inline-block;margin-bottom:10px;letter-spacing:1px">🎯 MOST CONFIDENT</div>' : ''}
  ${statsNote}

  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px">
    <div>
      <div style="font-size:16px;font-weight:700;color:#111827">${g.awayTeam} @ ${g.homeTeam}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px">${gameTime} · ${g.venue || ''}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:2px">
        ⚾ ${g.awayPitcherName} (${g.awayStats.starterERA?.toFixed(2) || '—'} ERA · ${g.awayStats.starterFIP?.toFixed(2) || '—'} FIP · ${g.awayStats.starterWHIP?.toFixed(2) || '—'} WHIP · ${g.awayStats.starterK9?.toFixed(1) || '—'} K9${g.awayStats.starterRestDays !== null ? ` · ${g.awayStats.starterRestDays}d rest` : ''})
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:1px">
        ⚾ ${g.homePitcherName} (${g.homeStats.starterERA?.toFixed(2) || '—'} ERA · ${g.homeStats.starterFIP?.toFixed(2) || '—'} FIP · ${g.homeStats.starterWHIP?.toFixed(2) || '—'} WHIP · ${g.homeStats.starterK9?.toFixed(1) || '—'} K9${g.homeStats.starterRestDays !== null ? ` · ${g.homeStats.starterRestDays}d rest` : ''})
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:1px">
        🛟 Bullpens: ${g.awayTeam?.split(' ').pop()} ${g.awayStats.bullpenERA?.toFixed(2)} ERA${g.awayStats.recentBullpenIP > 5 ? ` (⚠️ ${g.awayStats.recentBullpenIP.toFixed(1)} IP last 2d)` : ''} · ${g.homeTeam?.split(' ').pop()} ${g.homeStats.bullpenERA?.toFixed(2)} ERA${g.homeStats.recentBullpenIP > 5 ? ` (⚠️ ${g.homeStats.recentBullpenIP.toFixed(1)} IP last 2d)` : ''}
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:1px">
        🧑‍⚖️ HP: ${g.homePlateUmp || 'TBD'}${g.umpFactor !== 1.0 ? ` (${g.umpFactor > 1.0 ? '↑' : '↓'} ${g.umpFactor.toFixed(3)}x runs)` : ''}${g.homeStats.dayAfterNight || g.awayStats.dayAfterNight ? ` · ☀️ Day after night` : ''}
      </div>
    </div>
    <div style="text-align:right">
      <div style="font-size:22px;font-weight:800;color:${g.confidenceScore >= 70 ? '#16a34a' : g.confidenceScore >= 55 ? '#ca8a04' : '#dc2626'}">${g.confidenceScore}%</div>
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">Confidence</div>
    </div>
  </div>

  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Pick</div>
      <div style="font-size:15px;font-weight:800;color:#16a34a">${g.pick}</div>
      <div style="font-size:12px;color:#6b7280">${fmtOdds(g.pickOdds)} · ${g.bookmaker || 'Est.'}</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Sim Win Prob</div>
      <div style="font-size:15px;font-weight:800;color:#1d4ed8">${g.pick === g.homeTeam ? s.homeWinPct : s.awayWinPct}%</div>
      <div style="font-size:12px;color:#6b7280">vs Vegas ${(g.impliedP * 100).toFixed(1)}%</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Opponent Win%</div>
      <div style="font-size:15px;font-weight:800;color:#dc2626">${g.pick === g.homeTeam ? s.awayWinPct : s.homeWinPct}%</div>
      <div style="font-size:12px;color:#6b7280">CI: ${s.ciLow}–${s.ciHigh}%</div>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:10px 14px;flex:1;min-width:110px">
      <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Kelly Bet</div>
      <div style="font-size:15px;font-weight:800;color:#111827">$${bet}</div>
      <div style="font-size:12px;color:#6b7280">${g.kelly.toFixed(1)}% bankroll</div>
    </div>
  </div>

  <div style="background:#eff6ff;border-radius:8px;padding:14px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">
      🎲 10,000,000 Monte Carlo Simulations · MLB Stats API inputs
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
      Inputs: Starters ${g.awayStats.starterERA?.toFixed(2) || '—'}/${g.homeStats.starterERA?.toFixed(2) || '—'} ERA · Bullpens ${g.awayStats.bullpenERA?.toFixed(2) || '—'}/${g.homeStats.bullpenERA?.toFixed(2) || '—'} (fatigue ${g.awayStats.bullpenFatigue?.toFixed(2) || '1.00'}x/${g.homeStats.bullpenFatigue?.toFixed(2) || '1.00'}x) · 
      Lineup ${g.awayStats.lineupOBP ? g.awayStats.lineupOBP.toFixed(3) : 'team'}/${g.homeStats.lineupOBP ? g.homeStats.lineupOBP.toFixed(3) : 'team'} OBP · 
      Park ${g.homeStats.parkFactor?.toFixed(2)} · Ump ${g.umpFactor?.toFixed(3) || '1.000'}
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
    <div style="color:#86efac;font-size:11px;margin-top:4px">Top 5 Highest Confidence Picks · 10M Monte Carlo · MLB Stats API</div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
    ${[['Top Picks', sorted.length], ['Avg Confidence', sorted.length ? Math.round(sorted.reduce((a,g)=>a+g.confidenceScore,0)/sorted.length)+'%' : '—'], ['Highest Prob', best ? (best.pick===best.homeTeam?best.sim.homeWinPct:best.sim.awayWinPct)+'%' : '—'], ['Top Bet', best ? '$' + ((best.kelly / 100) * bankroll).toFixed(0) : '—']].map(([l, v]) =>
      `<div style="background:#fff;border-radius:10px;padding:14px;text-align:center;border:1px solid #e5e7eb">
        <div style="font-size:22px;font-weight:700;color:#16a34a">${v}</div>
        <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.5px">${l}</div>
      </div>`
    ).join('')}
  </div>

  ${cards}

  <div style="text-align:center;color:#9ca3af;font-size:11px;padding:16px;line-height:1.8">
    Powered by MLB Stats API · 10M Poisson sims · Pitching-first model: starter ERA/FIP/WHIP/K9 + rest days + bullpen fatigue + lineup OBP/SLG · Kelly capped at 25%<br>
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
    home_plate_ump: g.homePlateUmp || null, ump_factor: g.umpFactor ?? null,
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
  console.log(`Running 10,000,000 simulations per game for ${games.length} games...`);
  const analyzed = games.map(analyzeGame).sort((a, b) => b.confidenceScore - a.confidenceScore);

  // 6. Get AI reasoning
  console.log('Getting AI reasoning...');
  const reasoning = await getAIReasoning(analyzed, ANTHROPIC_API_KEY);
  for (const g of analyzed) {
    const r = reasoning.find(r => {
      if (!r.matchup) return false;
      const m = r.matchup.toLowerCase();
      // Match both teams — use last two words to disambiguate (e.g. "Red Sox" vs "White Sox")
      const awayKey = g.awayTeam?.split(' ').slice(-2).join(' ').toLowerCase();
      const homeKey = g.homeTeam?.split(' ').slice(-2).join(' ').toLowerCase();
      return m.includes(awayKey) && m.includes(homeKey);
    }) || reasoning.find(r => {
      // Fallback: single last word match (for cases where AI abbreviated names)
      if (!r.matchup) return false;
      const m = r.matchup.toLowerCase();
      return m.includes(g.homeTeam?.split(' ').pop().toLowerCase()) &&
             m.includes(g.awayTeam?.split(' ').pop().toLowerCase());
    });
    g.reasoning = r?.reasoning || '';
    g.commence_time = r?.commence_time || g.commence_time;
  }

  // 7. Save + send
  savePicks(analyzed, dataDir);

  // 8. Save to season database
  const dbDate = new Date().toISOString().split('T')[0];
  db.savePredictions(dbDate, analyzed);

  const html = buildPicksEmail(analyzed, timeLabel);
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  await sendEmail(EMAIL_TO, GMAIL_USER, GMAIL_APP_PASSWORD,
    `⚾ MLB Picks — ${timeLabel} · ${date} · Top 5 Confidence Picks`, html);
  console.log('Done!');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
