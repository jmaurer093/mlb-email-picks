const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { simulatePitcherKs, simulateBatterHits } = require('./player-props');

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

// ─── Distribution Samplers ────────────────────────────────────────────────────
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

// Gamma sampler via Marsaglia & Tsang's method (used to build NegBin)
function gammaSample(shape, scale) {
  if (shape < 1) {
    // Boost via uniform power transformation
    return gammaSample(shape + 1, scale) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do {
      const u = Math.random(), v2 = Math.random();
      x = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u2 = Math.random();
    if (u2 < 1 - 0.0331 * Math.pow(x, 4)) return d * v * scale;
    if (Math.log(u2) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

// Negative Binomial sampler — gamma-Poisson mixture.
// Variance = lambda + lambda^2 / k (vs Poisson variance = lambda).
// Higher k = closer to Poisson; lower k = fatter tails (more blowouts).
// MLB run data fits k ≈ 4–6 reasonably well.
function negBinSample(lambda, k = 5) {
  if (lambda <= 0) return 0;
  const adjustedLambda = gammaSample(k, lambda / k);
  return poissonSample(adjustedLambda);
}

function runMonteCarlo(homeStats, awayStats, weather, umpFactor = 1.0, opts = {}) {
  const {
    N = 10000000,
    distribution = 'negbin',  // 'poisson' or 'negbin'
    dispersionK = 5,          // NegBin dispersion; lower = fatter tails
    correlation = -0.05,      // mild negative correlation home/away run totals
  } = opts;
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

  // Travel/series/injury context (combined; 1.0 = neutral)
  const homeCtxFactor = safeNum(homeStats.contextFactor, 1.0);
  const awayCtxFactor = safeNum(awayStats.contextFactor, 1.0);

  // ─── DEFENSIVE FACTORS ─────────────────────────────────────────────────────
  // Good defense suppresses opposing runs. defFactor < 1.0 = elite defense,
  // > 1.0 = poor defense. We apply OPPOSING team's defense to limit each
  // team's offense (since defense converts batted balls into outs).
  const homeDefFactor = safeNum(homeStats.defFactor, 1.0);
  const awayDefFactor = safeNum(awayStats.defFactor, 1.0);

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
  // OPPOSING team's defensive factor multiplies inward — good defense = fewer runs allowed.
  const homeLambda =
    awayAllowedPerGame *           // opposing pitching is primary
    homeFormFactor *               // home offense (dampened, recency-blended)
    homePlatoon *                  // handedness
    homeDanFactor *                // day-after-night fatigue
    homeCtxFactor *                // travel + series + injuries
    awayDefFactor *                // away team's defense suppresses home offense
    parkFactor * windFactor * tempFactor * umpFactor;

  const awayLambda =
    homeAllowedPerGame *
    awayFormFactor *
    awayPlatoon *
    awayDanFactor *
    awayCtxFactor *
    homeDefFactor *                // home team's defense suppresses away offense
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

  // ─── SIMULATION LOOP ──────────────────────────────────────────────────────
  // Use NegBin by default for fatter tails (more realistic blowout frequency).
  // Mild negative correlation between home/away runs: in real games, one side's
  // dominance often constrains the other (good pitching ≠ guaranteed offense).
  // Implementation: share a latent "game pace" variable between draws.
  const sample = (lambda) =>
    distribution === 'negbin' ? negBinSample(lambda, dispersionK) : poissonSample(lambda);

  let hW = 0, aW = 0, push = 0, hF5 = 0, aF5 = 0, f5P = 0;
  let runSum = 0, f5Sum = 0, kSum = 0, hrSum = 0, hitsSum = 0;
  const runDist = new Array(35).fill(0);

  // Correlation factor [-1, 1]. We implement via shared multiplicative noise:
  // each game samples a small pace-modifier z, applied positively to one side
  // and negatively to the other when correlation is negative.
  const corrStrength = Math.abs(correlation);
  const corrSign = correlation < 0 ? -1 : 1;

  for (let i = 0; i < N; i++) {
    // Shared latent game-pace adjustment for correlation
    let hAdj = 1.0, aAdj = 1.0;
    if (corrStrength > 0) {
      // Symmetric multiplicative perturbation; mean ≈ 1.0
      const z = (Math.random() - 0.5) * 2 * corrStrength * 0.2; // ±~1% at default
      hAdj = 1.0 + z;
      aAdj = 1.0 + corrSign * z;
    }
    const hr = sample(homeLambda * hAdj);
    const ar = sample(awayLambda * aAdj);
    const hf = sample(homeF5L * hAdj);
    const af = sample(awayF5L * aAdj);
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
    kSum += sample(homeKL) + sample(awayKL);
    hrSum += sample(homeHRL) + sample(awayHRL);
    hitsSum += sample(homeHitsL) + sample(awayHitsL);
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
    const [hitting, pitching, splits, lastX, fielding] = await Promise.all([
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=season&group=hitting&season=2026`),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=season&group=pitching&season=2026`),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=statSplits&sitCodes=h,a&group=hitting&season=2026`).catch(() => ({})),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=lastXGames&group=hitting&season=2026&limit=14`).catch(() => ({})),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/stats?stats=season&group=fielding&season=2026`).catch(() => ({}))
    ]);
    const h = hitting.stats?.[0]?.splits?.[0]?.stat || {};
    const p = pitching.stats?.[0]?.splits?.[0]?.stat || {};
    const f = fielding.stats?.[0]?.splits?.[0]?.stat || {};
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

    // ─── DEFENSIVE METRICS ─────────────────────────────────────────────────
    // The free MLB API gives fielding %, errors, double plays. The good stuff
    // (OAA, framing runs, DRS) is FanGraphs-proprietary, so we proxy via:
    //   1. Fielding percentage (league avg ~0.984)
    //   2. Errors per game
    //   3. Pitcher BABIP from pitching stats (lower = better defense behind them)
    const fp = safeNum(f.fielding, 0.984);
    const errors = safeNum(f.errors, 0);
    const errorsPerGame = errors / gamesPlayed;
    // BABIP allowed is a strong defense + luck proxy. League avg ~0.290.
    const babipAllowed = safeNum(p.babip, 0.290);

    // Build defensive efficiency factor — lower = better defense (suppresses runs)
    // Normalized so 1.00 = average defense. Range roughly 0.96 (elite) to 1.04 (poor).
    const fpDelta = (0.984 - fp) * 4.0;            // +/- 1.6% for elite vs poor FP
    const babipDelta = (babipAllowed - 0.290) * 0.5; // +/- 1.5% for BABIP swings
    const defFactor = Math.max(0.96, Math.min(1.04, 1.0 + fpDelta + babipDelta));

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
      // Defense
      fieldingPct: fp,
      errorsPerGame,
      babipAllowed,
      defFactor,
      gamesPlayed,
    };
  } catch(e) {
    return {};
  }
}

// ─── Batter Stat Fetcher (for prop simulation — by player ID) ────────────────
// Caches by ID so repeat lookups within a single run don't re-hit the API.
const __batterStatCache = {};
async function fetchBatterStats(batterId) {
  if (!batterId) return null;
  if (__batterStatCache[batterId]) return __batterStatCache[batterId];
  try {
    const [season, info] = await Promise.all([
      httpsGet(`https://${MLB_BASE}/api/v1/people/${batterId}/stats?stats=season&group=hitting&season=2026`).catch(() => ({})),
      httpsGet(`https://${MLB_BASE}/api/v1/people/${batterId}`).catch(() => ({}))
    ]);
    const s = season.stats?.[0]?.splits?.[0]?.stat || {};
    const stats = {
      name: info.people?.[0]?.fullName || null,
      avg: parseFloat(s.avg) || null,
      obp: parseFloat(s.obp) || null,
      slg: parseFloat(s.slg) || null,
      ops: parseFloat(s.ops) || null,
      ab: parseInt(s.atBats) || 0,
      bats: info.people?.[0]?.batSide?.code || 'R',
    };
    __batterStatCache[batterId] = stats;
    return stats;
  } catch(e) {
    return null;
  }
}

// Fuzzy name match — props come back with names like "Aaron Judge" but our
// lineup gives us IDs. We resolve via the team roster for matching.
function normalizeName(n) {
  return (n || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();
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

// ─── Batter-vs-Pitcher Head-to-Head Matchup ──────────────────────────────────
// MLB API endpoint: stats=vsPlayer&opposingPlayerId=X gives career H2H stats.
// CRITICAL: H2H samples are noisy. A 3-for-7 batter looks "great" but with
// just 7 PA the regression-to-mean true talent is barely above his platoon
// split. We apply Bayesian shrinkage based on PA count.
async function fetchBatterVsPitcher(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;
  try {
    const data = await httpsGet(
      `https://${MLB_BASE}/api/v1/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`
    );
    // vsPlayer returns career splits; we want the totals split
    const splits = data.stats?.[0]?.splits || [];
    // Prefer total split, fall back to most recent season
    const total = splits.find(s => !s.season) || splits[0];
    const stat = total?.stat;
    if (!stat) return null;
    const pa = safeNum(stat.plateAppearances, 0);
    if (pa < 1) return null;
    return {
      pa,
      obp: parseFloat(stat.obp) || null,
      slg: parseFloat(stat.slg) || null,
      avg: parseFloat(stat.avg) || null,
      ops: parseFloat(stat.ops) || null,
      hr: safeNum(stat.homeRuns, 0),
      so: safeNum(stat.strikeOuts, 0),
      bb: safeNum(stat.baseOnBalls, 0),
    };
  } catch(e) {
    return null;
  }
}

// Bayesian shrinkage — weight H2H by PA count, regress to platoon baseline.
// Heuristic: 50 PA threshold for "full weight" (still noisy at MLB level, but a
// reasonable signal). Below that we partially trust H2H, partially trust baseline.
function regressH2H(h2h, baselineOBP, baselineSLG) {
  if (!h2h || h2h.pa < 1 || h2h.obp === null || h2h.slg === null) {
    return { obp: baselineOBP, slg: baselineSLG, h2hWeight: 0, pa: 0 };
  }
  const REGRESSION_PA = 50; // shrinkage constant: 50 PA = half weight on H2H
  const weight = h2h.pa / (h2h.pa + REGRESSION_PA);
  const regOBP = h2h.obp * weight + baselineOBP * (1 - weight);
  const regSLG = h2h.slg * weight + baselineSLG * (1 - weight);
  return { obp: regOBP, slg: regSLG, h2hWeight: weight, pa: h2h.pa };
}

// Expanded fetchLineupStats — pulls top 7 batters with platoon splits AND
// H2H matchup vs the opposing starter. Returns matchup-adjusted lineup OBP/SLG.
async function fetchLineupStats(batterIds, pitcherHand = 'R', opposingPitcherId = null) {
  if (!batterIds || batterIds.length === 0) return null;
  try {
    const top7 = batterIds.slice(0, 7);
    const sitCode = pitcherHand === 'L' ? 'vl' : 'vr';
    // Three calls per batter: season, platoon split, H2H vs starter
    const results = await Promise.all(top7.map(id =>
      Promise.all([
        httpsGet(`https://${MLB_BASE}/api/v1/people/${id}/stats?stats=season&group=hitting&season=2026`).catch(() => ({})),
        httpsGet(`https://${MLB_BASE}/api/v1/people/${id}/stats?stats=statSplits&sitCodes=${sitCode}&group=hitting&season=2026`).catch(() => ({})),
        opposingPitcherId ? fetchBatterVsPitcher(id, opposingPitcherId).catch(() => null) : Promise.resolve(null),
      ])
    ));
    // Lineup order weighting — top of order sees more PAs. Weights sum to ~1.0
    // for the top 7. Roughly approximates expected PA share by lineup spot.
    const orderWeights = [0.165, 0.160, 0.155, 0.150, 0.140, 0.125, 0.105];
    let weightedSeasonOBP = 0, weightedSeasonSLG = 0, totalWeight = 0;
    let weightedPlatoonOBP = 0, weightedPlatoonSLG = 0, platoonWeight = 0;
    let weightedMatchupOBP = 0, weightedMatchupSLG = 0;
    let battersFound = 0, h2hBattersFound = 0, totalH2HPA = 0;
    for (let i = 0; i < results.length; i++) {
      const [season, splits, h2h] = results[i];
      const w = orderWeights[i] || 0.10;
      const s = season.stats?.[0]?.splits?.[0]?.stat || {};
      const seasonOBP = parseFloat(s.obp);
      const seasonSLG = parseFloat(s.slg);
      if (!isNaN(seasonOBP) && !isNaN(seasonSLG)) {
        weightedSeasonOBP += seasonOBP * w;
        weightedSeasonSLG += seasonSLG * w;
        totalWeight += w;
        battersFound++;
      } else {
        continue; // skip batter entirely if we can't get season stats
      }
      const sp = splits.stats?.[0]?.splits?.[0]?.stat || {};
      const pObp = parseFloat(sp.obp);
      const pSlg = parseFloat(sp.slg);
      const platoonOBP = !isNaN(pObp) ? pObp : seasonOBP;
      const platoonSLG = !isNaN(pSlg) ? pSlg : seasonSLG;
      weightedPlatoonOBP += platoonOBP * w;
      weightedPlatoonSLG += platoonSLG * w;
      platoonWeight += w;
      // Matchup-adjusted: regress H2H toward platoon baseline
      const matchup = regressH2H(h2h, platoonOBP, platoonSLG);
      weightedMatchupOBP += matchup.obp * w;
      weightedMatchupSLG += matchup.slg * w;
      if (h2h && h2h.pa > 0) {
        h2hBattersFound++;
        totalH2HPA += h2h.pa;
      }
    }
    if (battersFound === 0 || totalWeight === 0) return null;
    return {
      // Season aggregate
      lineupOBP: weightedSeasonOBP / totalWeight,
      lineupSLG: weightedSeasonSLG / totalWeight,
      // Platoon-adjusted (lineup vs starter's handedness)
      lineupVsHandOBP: weightedPlatoonOBP / platoonWeight,
      lineupVsHandSLG: weightedPlatoonSLG / platoonWeight,
      // Matchup-adjusted (H2H regressed to platoon baseline)
      lineupMatchupOBP: weightedMatchupOBP / platoonWeight,
      lineupMatchupSLG: weightedMatchupSLG / platoonWeight,
      battersFound,
      h2hBattersFound,
      totalH2HPA,
    };
  } catch(e) {
    return null;
  }
}

// ─── Bullpen Fatigue (enhanced — tracks high-leverage and closer usage) ──────
// Goes beyond raw IP. The same 5 IP from mop-up guys is very different from
// 5 IP from a team's top 3 high-leverage arms. We also flag when a closer
// has thrown back-to-back-to-back (almost always unavailable today).
async function fetchBullpenFatigue(teamId, gameDate) {
  const empty = {
    fatigueMultiplier: 1.0,
    recentBullpenIP: 0,
    highLeverageIP: 0,
    closerBackToBack: false,
    closerThreeStraight: false,
    priorGameTime: null,
  };
  if (!teamId || !gameDate) return empty;
  try {
    const today = new Date(gameDate);
    // Look back 3 days now (instead of 2) so we can detect 3-straight closer usage
    const start = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sched = await httpsGet(
      `https://${MLB_BASE}/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}&hydrate=probablePitcher`
    );
    const games = (sched.dates || []).flatMap(d => d.games || [])
      .filter(g => g.status?.abstractGameState === 'Final')
      .sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || ''));

    // Per-pitcher IP tracking across the lookback window
    // pitcherUsage: { pitcherId: [{ date, ip, leverageHint }] }
    const pitcherUsage = {};
    let totalReliefIP = 0;
    let priorGameTime = null;

    // Last-2-days totals (matches the original fatigue logic)
    const cutoff2Days = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
    let last2DaysIP = 0;

    for (const g of games) {
      if (!priorGameTime || g.gameDate > priorGameTime) priorGameTime = g.gameDate;
      try {
        const box = await httpsGet(`https://${MLB_BASE}/api/v1/game/${g.gamePk}/boxscore`);
        const isHome = box.teams?.home?.team?.id === teamId;
        const teamBox = isHome ? box.teams.home : box.teams.away;
        const pitcherIds = teamBox?.pitchers || [];
        const gameDt = new Date(g.gameDate);
        const isLast2Days = gameDt >= cutoff2Days;
        // First pitcher is starter, skip; rest are relievers
        for (let i = 1; i < pitcherIds.length; i++) {
          const pid = pitcherIds[i];
          const pStat = teamBox.players?.[`ID${pid}`]?.stats?.pitching;
          if (!pStat?.inningsPitched) continue;
          const ip = parseFloat(pStat.inningsPitched) || 0;
          // Leverage hint: late-inning appearance (8th/9th) is high-leverage proxy.
          // The MLB API doesn't expose Leverage Index, so we infer from save/hold
          // situations and which inning they entered.
          const saves = safeNum(pStat.saves, 0);
          const holds = safeNum(pStat.holds, 0);
          const isHighLeverage = saves > 0 || holds > 0 || (i >= pitcherIds.length - 2);
          if (!pitcherUsage[pid]) pitcherUsage[pid] = [];
          pitcherUsage[pid].push({ date: g.gameDate, ip, isHighLeverage, isCloser: saves > 0 });
          totalReliefIP += ip;
          if (isLast2Days) last2DaysIP += ip;
        }
      } catch(e) { /* skip this game's box */ }
    }

    // Identify the closer — pitcher with most saves in the window (proxy)
    let closerId = null;
    let maxSaves = 0;
    for (const [pid, uses] of Object.entries(pitcherUsage)) {
      const saveAppearances = uses.filter(u => u.isCloser).length;
      if (saveAppearances > maxSaves) {
        maxSaves = saveAppearances;
        closerId = pid;
      }
    }

    // Closer back-to-back / 3-straight detection
    let closerBackToBack = false;
    let closerThreeStraight = false;
    if (closerId && pitcherUsage[closerId]) {
      const dates = pitcherUsage[closerId].map(u => u.date.split('T')[0]).sort();
      const yest = new Date(today.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const dayBefore = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const twoBefore = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const usedYest = dates.some(d => d === yest);
      const usedDayBefore = dates.some(d => d === dayBefore);
      const usedTwoBefore = dates.some(d => d === twoBefore);
      closerBackToBack = usedYest && usedDayBefore;
      closerThreeStraight = usedYest && usedDayBefore && usedTwoBefore;
    }

    // High-leverage IP from last 2 days only
    let highLeverageIP = 0;
    for (const uses of Object.values(pitcherUsage)) {
      for (const u of uses) {
        if (u.isHighLeverage && new Date(u.date) >= cutoff2Days) {
          highLeverageIP += u.ip;
        }
      }
    }

    // ─── ENHANCED FATIGUE MULTIPLIER ───────────────────────────────────────
    // Base from total relief IP, then penalize for high-leverage usage and
    // closer unavailability. Cap at 1.25 to keep extreme cases reasonable.
    let fatigueMultiplier = 1.0;
    if (last2DaysIP >= 8) fatigueMultiplier = 1.16;
    else if (last2DaysIP >= 5) fatigueMultiplier = 1.08;
    else if (last2DaysIP >= 3) fatigueMultiplier = 1.03;
    // High-leverage compounding: if >=3 IP from setup/closer arms, add penalty
    if (highLeverageIP >= 4) fatigueMultiplier += 0.06;
    else if (highLeverageIP >= 2.5) fatigueMultiplier += 0.03;
    // Closer effectively unavailable
    if (closerThreeStraight) fatigueMultiplier += 0.05;
    else if (closerBackToBack) fatigueMultiplier += 0.025;
    fatigueMultiplier = Math.min(1.25, fatigueMultiplier);

    return {
      fatigueMultiplier,
      recentBullpenIP: last2DaysIP,
      highLeverageIP,
      closerBackToBack,
      closerThreeStraight,
      priorGameTime,
    };
  } catch(e) {
    return empty;
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

// ─── Injury / IL Awareness ───────────────────────────────────────────────────
// MLB roster endpoint exposes 40-man with `status` field. We pull "active" vs
// "injured list (10/15/60-day)". Then compare to season top hitters by OPS to
// flag if any star bat is unavailable.
async function fetchInjuryReport(teamId) {
  if (!teamId) return { ilList: [], starsMissing: 0 };
  try {
    const [roster, top] = await Promise.all([
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/roster?rosterType=fullRoster`).catch(() => ({})),
      httpsGet(`https://${MLB_BASE}/api/v1/teams/${teamId}/leaders?leaderCategories=onBasePlusSlugging&season=2026&group=hitting&limit=5`).catch(() => ({}))
    ]);
    const players = roster.roster || [];
    const ilList = players
      .filter(p => /injured list/i.test(p.status?.description || ''))
      .map(p => ({ id: p.person?.id, name: p.person?.fullName, status: p.status?.description }));
    // Cross-reference IL with top hitters to count stars missing
    const topIds = (top.leagueLeaders?.[0]?.leaders || []).map(l => l.person?.id);
    const starsMissing = ilList.filter(p => topIds.includes(p.id)).length;
    return { ilList, starsMissing };
  } catch(e) {
    return { ilList: [], starsMissing: 0 };
  }
}

// ─── Travel & Series Context ─────────────────────────────────────────────────
// Tracks: (1) cross-country/multi-timezone travel since last game,
// (2) series game number (game 4 of a 4-game series often shows fatigue),
// (3) getaway day (last game of road series — known offensive bump from
//     pitchers nibbling and teams playing loose).
const VENUE_TZ_OFFSET = {
  // Rough UTC offset (standard time; DST ignored for relative comparison)
  2392: -7, 2395: -5, 4169: -5, 3313: -5, 2394: -6, 32: -5, 4705: -6,
  5: -6, 2500: -5, 15: -5, 2397: -5, 2396: -6, 4140: -5, 3289: -6,
  2507: -6, 2680: -5, 3312: -5, 4: -5, 2889: -6, 17: -7, 2536: -5,
  2518: -6, 2393: -8, 680: -5, 10: -5, 3309: -8, 2681: -8, 2602: -8, 19: -8,
};

async function fetchTravelAndSeries(teamId, gameDate, currentVenueId) {
  const empty = {
    timezonesCrossed: 0,
    longFlight: false,
    seriesGameNumber: 1,
    isGetawayDay: false,
  };
  if (!teamId || !gameDate) return empty;
  try {
    const today = new Date(gameDate);
    const start = new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const end = new Date(today.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sched = await httpsGet(
      `https://${MLB_BASE}/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}`
    );
    const allGames = (sched.dates || []).flatMap(d => d.games || [])
      .sort((a, b) => (a.gameDate || '').localeCompare(b.gameDate || ''));

    // Most recent prior completed game
    const priorGames = allGames.filter(g =>
      g.status?.abstractGameState === 'Final' && new Date(g.gameDate) < today
    );
    const lastGame = priorGames[priorGames.length - 1];

    // Timezone delta from last game
    let timezonesCrossed = 0;
    if (lastGame?.venue?.id && currentVenueId) {
      const lastTz = VENUE_TZ_OFFSET[lastGame.venue.id];
      const currTz = VENUE_TZ_OFFSET[currentVenueId];
      if (lastTz !== undefined && currTz !== undefined) {
        timezonesCrossed = Math.abs(currTz - lastTz);
      }
    }
    const longFlight = timezonesCrossed >= 2;

    // Series game number — count consecutive games at same venue working back
    let seriesGameNumber = 1;
    for (let i = priorGames.length - 1; i >= 0; i--) {
      if (priorGames[i].venue?.id === currentVenueId) seriesGameNumber++;
      else break;
    }
    // Detect getaway day: this is last home/away series day if next game is at different venue
    let isGetawayDay = false;
    const nextGame = allGames.find(g => new Date(g.gameDate) > today);
    if (nextGame && nextGame.venue?.id && nextGame.venue.id !== currentVenueId) {
      isGetawayDay = true;
    }
    return { timezonesCrossed, longFlight, seriesGameNumber, isGetawayDay };
  } catch(e) {
    return empty;
  }
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

    // Phase 1 — core data (pitchers, teams, venue, lineup, bullpen fatigue,
    // injuries, travel/series context)
    const [
      homePitcher, awayPitcher, homeTeam, awayTeam, venue, lineup,
      homeFatigue, awayFatigue, homeInjuries, awayInjuries,
      homeTravel, awayTravel
    ] = await Promise.all([
      fetchPitcherStats(homePitcherId, gameDate),
      fetchPitcherStats(awayPitcherId, gameDate),
      fetchTeamStats(homeTeamId),
      fetchTeamStats(awayTeamId),
      fetchVenueInfo(venueId),
      fetchLineup(game.gamePk),
      fetchBullpenFatigue(homeTeamId, gameDate),
      fetchBullpenFatigue(awayTeamId, gameDate),
      fetchInjuryReport(homeTeamId),
      fetchInjuryReport(awayTeamId),
      fetchTravelAndSeries(homeTeamId, gameDate, venueId),
      fetchTravelAndSeries(awayTeamId, gameDate, venueId),
    ]);

    // Phase 2 — lineup stats (depends on lineup IDs AND opposing pitcher ID for H2H)
    const [homeLineupStats, awayLineupStats] = await Promise.all([
      fetchLineupStats(lineup.home, awayPitcher.throws || 'R', awayPitcherId),
      fetchLineupStats(lineup.away, homePitcher.throws || 'R', homePitcherId),
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
      const hoursBetween = (current - prior) / (1000 * 60 * 60);
      const isDayGame = current.getUTCHours() < 21;
      return hoursBetween < 18 && hoursBetween > 0 && isDayGame;
    };
    const homeDayAfterNight = dayAfterNight(homeFatigue.priorGameTime, gameDate);
    const awayDayAfterNight = dayAfterNight(awayFatigue.priorGameTime, gameDate);

    // ─── BLEND MATCHUP-ADJUSTED LINEUP INTO TEAM OBP/SLG ───────────────────
    // Priority: matchup-adjusted (H2H regressed) > lineup vs handedness > raw
    // lineup > team season OBP/SLG. This is what flows into platoon + offense factors.
    const homeOBP =
      homeLineupStats?.lineupMatchupOBP ??
      homeLineupStats?.lineupVsHandOBP ??
      homeLineupStats?.lineupOBP ??
      homeTeam.obp ?? null;
    const homeSLG =
      homeLineupStats?.lineupMatchupSLG ??
      homeLineupStats?.lineupVsHandSLG ??
      homeLineupStats?.lineupSLG ??
      homeTeam.slg ?? null;
    const awayOBP =
      awayLineupStats?.lineupMatchupOBP ??
      awayLineupStats?.lineupVsHandOBP ??
      awayLineupStats?.lineupOBP ??
      awayTeam.obp ?? null;
    const awaySLG =
      awayLineupStats?.lineupMatchupSLG ??
      awayLineupStats?.lineupVsHandSLG ??
      awayLineupStats?.lineupSLG ??
      awayTeam.slg ?? null;

    // Home/away splits when available
    const homeRPGAdjusted = homeTeam.homeRPG > 0 ? homeTeam.homeRPG : (homeTeam.runsPerGame ?? 4.5);
    const awayRPGAdjusted = awayTeam.awayRPG > 0 ? awayTeam.awayRPG : (awayTeam.runsPerGame ?? 4.5);

    // ─── TRAVEL/SERIES MULTIPLIERS (small, applied to offense) ─────────────
    // Long flight cross-timezone: -2-3% offensive output
    // Series game 4+: -2% (lineup fatigue + pitchers know hitters)
    // Getaway day: +1% (loose play)
    // Stars missing: -1.5% per star (capped at -5%)
    const buildContextFactor = (travel, injuries) => {
      let f = 1.0;
      if (travel.longFlight) f *= (1.0 - 0.02 * Math.min(travel.timezonesCrossed, 3) / 3);
      if (travel.seriesGameNumber >= 4) f *= 0.98;
      if (travel.isGetawayDay) f *= 1.01;
      f *= Math.max(0.95, 1.0 - 0.015 * injuries.starsMissing);
      return f;
    };
    const homeContextFactor = buildContextFactor(homeTravel, homeInjuries);
    const awayContextFactor = buildContextFactor(awayTravel, awayInjuries);

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
      lineupIds: { home: lineup.home, away: lineup.away },
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
        highLeverageIP: homeFatigue.highLeverageIP,
        closerBackToBack: homeFatigue.closerBackToBack,
        closerThreeStraight: homeFatigue.closerThreeStraight,
        teamRPG: homeRPGAdjusted,
        teamHPG: homeTeam.hitsPerGame ?? 8.5,
        teamHRPG: homeTeam.hrPerGame ?? 1.1,
        teamOBP: homeOBP,
        teamSLG: homeSLG,
        teamAVG: homeTeam.avg,
        recent14RPG: homeTeam.recent14RPG,
        // Lineup detail (for reporting / AI prompt)
        lineupOBP: homeLineupStats?.lineupOBP ?? null,
        lineupSLG: homeLineupStats?.lineupSLG ?? null,
        lineupVsHandOBP: homeLineupStats?.lineupVsHandOBP ?? null,
        lineupVsHandSLG: homeLineupStats?.lineupVsHandSLG ?? null,
        lineupMatchupOBP: homeLineupStats?.lineupMatchupOBP ?? null,
        lineupMatchupSLG: homeLineupStats?.lineupMatchupSLG ?? null,
        lineupBattersFound: homeLineupStats?.battersFound ?? 0,
        h2hBattersFound: homeLineupStats?.h2hBattersFound ?? 0,
        totalH2HPA: homeLineupStats?.totalH2HPA ?? 0,
        // Defense
        fieldingPct: homeTeam.fieldingPct,
        defFactor: homeTeam.defFactor ?? 1.0,
        // Context
        dayAfterNight: homeDayAfterNight,
        timezonesCrossed: homeTravel.timezonesCrossed,
        longFlight: homeTravel.longFlight,
        seriesGameNumber: homeTravel.seriesGameNumber,
        isGetawayDay: homeTravel.isGetawayDay,
        contextFactor: homeContextFactor,
        starsMissing: homeInjuries.starsMissing,
        ilCount: homeInjuries.ilList.length,
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
        highLeverageIP: awayFatigue.highLeverageIP,
        closerBackToBack: awayFatigue.closerBackToBack,
        closerThreeStraight: awayFatigue.closerThreeStraight,
        teamRPG: awayRPGAdjusted,
        teamHPG: awayTeam.hitsPerGame ?? 8.5,
        teamHRPG: awayTeam.hrPerGame ?? 1.1,
        teamOBP: awayOBP,
        teamSLG: awaySLG,
        teamAVG: awayTeam.avg,
        recent14RPG: awayTeam.recent14RPG,
        lineupOBP: awayLineupStats?.lineupOBP ?? null,
        lineupSLG: awayLineupStats?.lineupSLG ?? null,
        lineupVsHandOBP: awayLineupStats?.lineupVsHandOBP ?? null,
        lineupVsHandSLG: awayLineupStats?.lineupVsHandSLG ?? null,
        lineupMatchupOBP: awayLineupStats?.lineupMatchupOBP ?? null,
        lineupMatchupSLG: awayLineupStats?.lineupMatchupSLG ?? null,
        lineupBattersFound: awayLineupStats?.battersFound ?? 0,
        h2hBattersFound: awayLineupStats?.h2hBattersFound ?? 0,
        totalH2HPA: awayLineupStats?.totalH2HPA ?? 0,
        fieldingPct: awayTeam.fieldingPct,
        defFactor: awayTeam.defFactor ?? 1.0,
        dayAfterNight: awayDayAfterNight,
        timezonesCrossed: awayTravel.timezonesCrossed,
        longFlight: awayTravel.longFlight,
        seriesGameNumber: awayTravel.seriesGameNumber,
        isGetawayDay: awayTravel.isGetawayDay,
        contextFactor: awayContextFactor,
        starsMissing: awayInjuries.starsMissing,
        ilCount: awayInjuries.ilList.length,
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

// ─── Player Prop Odds (Vegas lines for pitcher Ks + batter hits) ──────────────
// The Odds API splits props onto per-event endpoints. We list MLB events,
// match them to our games, then fetch player props per event.
// Markets used:
//   - pitcher_strikeouts  (over/under at lines like 5.5, 6.5)
//   - batter_hits         (over/under usually 0.5, 1.5)
// Each event request costs ~10 API credits — budget accordingly.
async function fetchEventList(oddsKey) {
  if (!oddsKey) return [];
  try {
    const data = await httpsGet(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${oddsKey}&dateFormat=iso`
    );
    return Array.isArray(data) ? data : [];
  } catch(e) {
    console.log('Events fetch failed:', e.message);
    return [];
  }
}

async function fetchEventProps(oddsKey, eventId) {
  if (!oddsKey || !eventId) return null;
  try {
    const data = await httpsGet(
      `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${eventId}/odds?apiKey=${oddsKey}&regions=us&markets=pitcher_strikeouts,batter_hits&oddsFormat=american&dateFormat=iso`
    );
    return data;
  } catch(e) {
    console.log(`  Props for ${eventId} unavailable:`, e.message);
    return null;
  }
}

// Match an event from the events list to a game by team names (Sox-safe)
function matchEvent(game, events) {
  for (const e of events) {
    const homeKey = game.homeTeam?.split(' ').slice(-2).join(' ').toLowerCase();
    const awayKey = game.awayTeam?.split(' ').slice(-2).join(' ').toLowerCase();
    const eHome = e.home_team?.toLowerCase() || '';
    const eAway = e.away_team?.toLowerCase() || '';
    if (eHome.includes(homeKey) && eAway.includes(awayKey)) return e;
  }
  for (const e of events) {
    const homeLast = game.homeTeam?.split(' ').pop()?.toLowerCase();
    const awayLast = game.awayTeam?.split(' ').pop()?.toLowerCase();
    const eHome = e.home_team?.toLowerCase() || '';
    const eAway = e.away_team?.toLowerCase() || '';
    if (homeLast && awayLast && eHome.includes(homeLast) && eAway.includes(awayLast)) return e;
  }
  return null;
}

// Extract pitcher K + batter hits prop lines from one event's payload
// Returns: { pitcherKs: [{name, line, overOdds, underOdds, bookmaker}], batterHits: [...] }
function extractProps(eventData) {
  const result = { pitcherKs: [], batterHits: [] };
  if (!eventData?.bookmakers) return result;

  // Prefer FanDuel, then DraftKings, then first available
  const bm = eventData.bookmakers.find(b => b.key === 'fanduel') ||
             eventData.bookmakers.find(b => b.key === 'draftkings') ||
             eventData.bookmakers[0];
  if (!bm) return result;

  const bookName = bm.title || 'Unknown';

  // Pitcher Ks — outcomes come as {name: "Over"/"Under", description: "Pitcher Name", point: line, price: odds}
  const ks = bm.markets?.find(m => m.key === 'pitcher_strikeouts');
  if (ks?.outcomes) {
    // Group outcomes by pitcher name
    const byPitcher = {};
    for (const o of ks.outcomes) {
      const name = o.description || o.participant || 'Unknown';
      if (!byPitcher[name]) byPitcher[name] = { name, line: o.point, overOdds: null, underOdds: null, bookmaker: bookName };
      if (o.name === 'Over') byPitcher[name].overOdds = o.price;
      else if (o.name === 'Under') byPitcher[name].underOdds = o.price;
      byPitcher[name].line = o.point ?? byPitcher[name].line;
    }
    result.pitcherKs = Object.values(byPitcher).filter(p => p.overOdds || p.underOdds);
  }

  // Batter hits
  const hits = bm.markets?.find(m => m.key === 'batter_hits');
  if (hits?.outcomes) {
    const byBatter = {};
    for (const o of hits.outcomes) {
      const name = o.description || o.participant || 'Unknown';
      // Many batter-hits markets only post O 0.5 line — we still track separately
      const key = `${name}|${o.point}`;
      if (!byBatter[key]) byBatter[key] = { name, line: o.point, overOdds: null, underOdds: null, bookmaker: bookName };
      if (o.name === 'Over') byBatter[key].overOdds = o.price;
      else if (o.name === 'Under') byBatter[key].underOdds = o.price;
      byBatter[key].line = o.point ?? byBatter[key].line;
    }
    result.batterHits = Object.values(byBatter).filter(b => b.overOdds || b.underOdds);
  }

  return result;
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
    homeOffense: `RPG: ${g.homeStats.teamRPG?.toFixed(2)} (last 14d: ${g.homeStats.recent14RPG?.toFixed(2) || 'N/A'}), Lineup OBP/SLG raw: ${g.homeStats.lineupOBP?.toFixed(3) || 'N/A'}/${g.homeStats.lineupSLG?.toFixed(3) || 'N/A'}, Matchup-adjusted (H2H regressed): ${g.homeStats.lineupMatchupOBP?.toFixed(3) || 'N/A'}/${g.homeStats.lineupMatchupSLG?.toFixed(3) || 'N/A'} [${g.homeStats.h2hBattersFound || 0} batters w/ H2H, ${g.homeStats.totalH2HPA || 0} total PA]${g.homeStats.dayAfterNight ? ' [day-after-night]' : ''}${g.homeStats.starsMissing ? ` [⚠ ${g.homeStats.starsMissing} stars on IL]` : ''}`,
    awayOffense: `RPG: ${g.awayStats.teamRPG?.toFixed(2)} (last 14d: ${g.awayStats.recent14RPG?.toFixed(2) || 'N/A'}), Lineup OBP/SLG raw: ${g.awayStats.lineupOBP?.toFixed(3) || 'N/A'}/${g.awayStats.lineupSLG?.toFixed(3) || 'N/A'}, Matchup-adjusted (H2H regressed): ${g.awayStats.lineupMatchupOBP?.toFixed(3) || 'N/A'}/${g.awayStats.lineupMatchupSLG?.toFixed(3) || 'N/A'} [${g.awayStats.h2hBattersFound || 0} batters w/ H2H, ${g.awayStats.totalH2HPA || 0} total PA]${g.awayStats.dayAfterNight ? ' [day-after-night]' : ''}${g.awayStats.starsMissing ? ` [⚠ ${g.awayStats.starsMissing} stars on IL]` : ''}`,
    homeDefense: `defFactor: ${g.homeStats.defFactor?.toFixed(3) || '1.000'} (FP: ${g.homeStats.fieldingPct?.toFixed(3) || 'N/A'})`,
    awayDefense: `defFactor: ${g.awayStats.defFactor?.toFixed(3) || '1.000'} (FP: ${g.awayStats.fieldingPct?.toFixed(3) || 'N/A'})`,
    homeContext: `Series game ${g.homeStats.seriesGameNumber || 1}${g.homeStats.isGetawayDay ? ' [GETAWAY DAY]' : ''}${g.homeStats.longFlight ? ` [LONG FLIGHT ${g.homeStats.timezonesCrossed}tz]` : ''}, ctx mult: ${g.homeStats.contextFactor?.toFixed(3)}`,
    awayContext: `Series game ${g.awayStats.seriesGameNumber || 1}${g.awayStats.isGetawayDay ? ' [GETAWAY DAY]' : ''}${g.awayStats.longFlight ? ` [LONG FLIGHT ${g.awayStats.timezonesCrossed}tz]` : ''}, ctx mult: ${g.awayStats.contextFactor?.toFixed(3)}`,
    homeBullpenDetail: `BP ERA: ${g.homeStats.bullpenERA?.toFixed(2)}, last-2d IP: ${g.homeStats.recentBullpenIP?.toFixed(1)} (HL: ${g.homeStats.highLeverageIP?.toFixed(1)}), closer: ${g.homeStats.closerThreeStraight ? '⚠ 3 STRAIGHT' : g.homeStats.closerBackToBack ? '⚠ B2B' : 'fresh'}, total mult: ${g.homeStats.bullpenFatigue?.toFixed(2)}x`,
    awayBullpenDetail: `BP ERA: ${g.awayStats.bullpenERA?.toFixed(2)}, last-2d IP: ${g.awayStats.recentBullpenIP?.toFixed(1)} (HL: ${g.awayStats.highLeverageIP?.toFixed(1)}), closer: ${g.awayStats.closerThreeStraight ? '⚠ 3 STRAIGHT' : g.awayStats.closerBackToBack ? '⚠ B2B' : 'fresh'}, total mult: ${g.awayStats.bullpenFatigue?.toFixed(2)}x`,
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

  const prompt = `You are an expert MLB betting analyst. Using real MLB Stats API inputs and 10-million-simulation Monte Carlo results (NegBin run distribution with mild negative correlation), provide sharp 2-3 sentence reasoning for each game.

PITCHING IS THE PRIMARY FACTOR. Lead with the starter matchup: ERA, FIP, WHIP, K/9, BB/9, rest days, recent pitch count workload. Then bullpen state — high-leverage IP and closer back-to-back/3-straight matter more than raw IP totals. After pitching, only then mention: matchup-adjusted lineup OBP/SLG (H2H regressed), defensive factor, travel/series context (long flight, getaway day, series game ≥4), park, weather, umpire.

Model factors applied: starter quality (heavily weighted) + rest + workload; bullpen ERA + last-2d IP + high-leverage IP + closer fatigue; today's actual lineup with H2H regression toward platoon split; home/away splits; last-14-days form; team defense (fielding %, BABIP-allowed); day-after-night; travel/timezones; series context; injury report (IL stars missing); platoon handedness; park, weather, umpire.

For each game cover: (1) PITCHING — starter vs starter with fatigue/rest concerns, (2) BULLPEN STATE — high-leverage usage and closer availability, (3) actionable betting insight referencing sim probability vs Vegas implied odds.

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

// ─── Prop Edge Calculator ────────────────────────────────────────────────────
// For each Vegas prop line, run a focused simulation, compare model probability
// to Vegas implied probability, compute EV + Kelly. Returns ranked edges.
function buildPropEdges(game) {
  const edges = [];
  if (!game.props) return edges;

  // Identify which side each pitcher is on (we know names from MLB API)
  const pitchers = [
    { name: game.homePitcherName, throws: game.homeStats.starterThrows,
      starterERA: game.homeStats.starterERA, starterFIP: game.homeStats.starterFIP,
      starterK9: game.homeStats.starterK9, starterBB9: game.homeStats.starterBB9,
      side: 'home', opp: game.awayStats },
    { name: game.awayPitcherName, throws: game.awayStats.starterThrows,
      starterERA: game.awayStats.starterERA, starterFIP: game.awayStats.starterFIP,
      starterK9: game.awayStats.starterK9, starterBB9: game.awayStats.starterBB9,
      side: 'away', opp: game.homeStats },
  ];

  // ── Pitcher Strikeouts ──
  for (const propLine of game.props.pitcherKs || []) {
    // Match prop's pitcher name to our two starters
    const propName = normalizeName(propLine.name);
    const match = pitchers.find(p => normalizeName(p.name).includes(propName) || propName.includes(normalizeName(p.name)));
    if (!match) continue;

    const sim = simulatePitcherKs(match, match.opp, { N: 200000, lines: [propLine.line] });
    const overP = sim.p_over[propLine.line] / 100;
    const underP = 1 - overP;

    // Compute EV for both sides
    if (propLine.overOdds) {
      const impliedOver = impliedProb(propLine.overOdds);
      const evOver = (overP * dec(propLine.overOdds) - 1) * 100;
      const kOver = Math.max(0, Math.min(10, ((overP * dec(propLine.overOdds) - 1) / (dec(propLine.overOdds) - 1)) * 100));
      if (evOver > 3) {
        edges.push({
          type: 'pitcher_ks',
          pick: `${match.name} OVER ${propLine.line} K`,
          player: match.name,
          line: propLine.line,
          side: 'over',
          odds: propLine.overOdds,
          simProb: +(overP * 100).toFixed(1),
          impliedProb: +(impliedOver * 100).toFixed(1),
          ev: +evOver.toFixed(2),
          kelly: +kOver.toFixed(2),
          simMean: sim.mean,
          bookmaker: propLine.bookmaker,
        });
      }
    }
    if (propLine.underOdds) {
      const impliedUnder = impliedProb(propLine.underOdds);
      const evUnder = (underP * dec(propLine.underOdds) - 1) * 100;
      const kUnder = Math.max(0, Math.min(10, ((underP * dec(propLine.underOdds) - 1) / (dec(propLine.underOdds) - 1)) * 100));
      if (evUnder > 3) {
        edges.push({
          type: 'pitcher_ks',
          pick: `${match.name} UNDER ${propLine.line} K`,
          player: match.name,
          line: propLine.line,
          side: 'under',
          odds: propLine.underOdds,
          simProb: +(underP * 100).toFixed(1),
          impliedProb: +(impliedUnder * 100).toFixed(1),
          ev: +evUnder.toFixed(2),
          kelly: +kUnder.toFixed(2),
          simMean: sim.mean,
          bookmaker: propLine.bookmaker,
        });
      }
    }
  }

  // ── Batter Hits ──
  // Match each prop by name against batter stats stored in game.batterStats
  const batterStats = game.batterStats || {};
  for (const propLine of game.props.batterHits || []) {
    const propName = normalizeName(propLine.name);
    let match = null;
    for (const [id, stat] of Object.entries(batterStats)) {
      if (!stat?.name) continue;
      const sn = normalizeName(stat.name);
      if (sn.includes(propName) || propName.includes(sn)) {
        match = stat;
        break;
      }
    }
    if (!match) continue;

    // Decide which pitcher this batter faces (opposing starter)
    // Heuristic: batter belongs to whichever team has this batter in their lineup
    const homeIds = (game.lineupIds?.home || []).map(String);
    const awayIds = (game.lineupIds?.away || []).map(String);
    const matchedId = Object.entries(batterStats).find(([id, s]) => s === match)?.[0];
    const isHomeBatter = homeIds.includes(matchedId);
    const facingPitcher = isHomeBatter ? pitchers.find(p => p.side === 'away') : pitchers.find(p => p.side === 'home');
    if (!facingPitcher) continue;

    const sim = simulateBatterHits(match, facingPitcher, { N: 50000, lines: [propLine.line] });
    const overP = sim.p_over[propLine.line] / 100;
    const underP = 1 - overP;

    if (propLine.overOdds) {
      const impliedOver = impliedProb(propLine.overOdds);
      const evOver = (overP * dec(propLine.overOdds) - 1) * 100;
      const kOver = Math.max(0, Math.min(10, ((overP * dec(propLine.overOdds) - 1) / (dec(propLine.overOdds) - 1)) * 100));
      if (evOver > 3) {
        edges.push({
          type: 'batter_hits',
          pick: `${match.name} OVER ${propLine.line} H`,
          player: match.name,
          line: propLine.line,
          side: 'over',
          odds: propLine.overOdds,
          simProb: +(overP * 100).toFixed(1),
          impliedProb: +(impliedOver * 100).toFixed(1),
          ev: +evOver.toFixed(2),
          kelly: +kOver.toFixed(2),
          simMean: sim.mean,
          bookmaker: propLine.bookmaker,
        });
      }
    }
    if (propLine.underOdds) {
      const impliedUnder = impliedProb(propLine.underOdds);
      const evUnder = (underP * dec(propLine.underOdds) - 1) * 100;
      const kUnder = Math.max(0, Math.min(10, ((underP * dec(propLine.underOdds) - 1) / (dec(propLine.underOdds) - 1)) * 100));
      if (evUnder > 3) {
        edges.push({
          type: 'batter_hits',
          pick: `${match.name} UNDER ${propLine.line} H`,
          player: match.name,
          line: propLine.line,
          side: 'under',
          odds: propLine.underOdds,
          simProb: +(underP * 100).toFixed(1),
          impliedProb: +(impliedUnder * 100).toFixed(1),
          ev: +evUnder.toFixed(2),
          kelly: +kUnder.toFixed(2),
          simMean: sim.mean,
          bookmaker: propLine.bookmaker,
        });
      }
    }
  }

  // Rank by EV descending, cap at 5 per game to avoid clutter
  return edges.sort((a, b) => b.ev - a.ev).slice(0, 5);
}

function analyzeGame(game, opts = {}) {
  const sim = runMonteCarlo(game.homeStats, game.awayStats, game.weather, game.umpFactor || 1.0, opts);

  // Primary pick — the side our simulation favors
  let pick, pickOdds, ourProb, impliedP, ev, kelly, pickSide;
  const ho = game.homeOdds, ao = game.awayOdds;

  if (sim.homeWinPct >= sim.awayWinPct) {
    pick = game.homeTeam;
    pickOdds = ho || -115;
    ourProb = sim.homeWinPct / 100;
    pickSide = 'home';
  } else {
    pick = game.awayTeam;
    pickOdds = ao || 105;
    ourProb = sim.awayWinPct / 100;
    pickSide = 'away';
  }
  impliedP = impliedProb(pickOdds);
  ev = (ourProb * dec(pickOdds) - 1) * 100;
  const d = dec(pickOdds);
  kelly = Math.max(0, Math.min(25, ((ourProb * d - 1) / (d - 1)) * 100));

  // ─── FADE ANALYSIS ──────────────────────────────────────────────────────
  // If our primary pick is -EV, check whether the opposite side has +EV.
  // Vegas is often more correct than our model when our edge is negative,
  // and sometimes the "fade" of our own pick has value on the other side.
  // Example: sim says HOME 52% but odds imply 56% — fading to AWAY at +130
  //   could yield +EV if AWAY implied prob (43%) < our 48% sim prob.
  const fadeSide = pickSide === 'home' ? 'away' : 'home';
  const fadeName = pickSide === 'home' ? game.awayTeam : game.homeTeam;
  const fadeOdds = pickSide === 'home' ? (ao || 105) : (ho || -115);
  const fadeProb = 1 - ourProb;
  const fadeImplied = impliedProb(fadeOdds);
  const fadeEV = (fadeProb * dec(fadeOdds) - 1) * 100;
  const fadeD = dec(fadeOdds);
  const fadeKelly = Math.max(0, Math.min(25, ((fadeProb * fadeD - 1) / (fadeD - 1)) * 100));

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

  // ─── PROP EDGES ─────────────────────────────────────────────────────────
  // Simulate every Vegas prop line on this game, return ranked +EV plays
  const propEdges = buildPropEdges(game);

  return {
    ...game, sim,
    // Primary
    pick, pickOdds, pickSide, ourProb, impliedP, ev, kelly,
    // Fade (Kelly on opposite side — actionable when primary EV is negative)
    fadeName, fadeOdds, fadeSide, fadeProb, fadeImplied, fadeEV, fadeKelly,
    // O/U + ranking
    ouPick, ouEdge, confidenceScore,
    // Player props
    propEdges,
  };
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

  ${g.ev < 0 && g.fadeEV > 0 ? `
  <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:12px 14px;margin-bottom:12px">
    <div style="font-size:11px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">
      ⚠️ Primary pick is -EV — Fade analysis suggests value on the other side
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr>
        <td style="padding:3px 0;color:#92400e">Fade pick: <strong>${g.fadeName}</strong> ${fmtOdds(g.fadeOdds)}</td>
        <td style="padding:3px 0;font-weight:700;text-align:right;color:#92400e">${(g.fadeProb * 100).toFixed(1)}% sim vs ${(g.fadeImplied * 100).toFixed(1)}% implied</td>
      </tr>
      <tr>
        <td style="padding:3px 0;color:#92400e">Fade EV / Kelly</td>
        <td style="padding:3px 0;font-weight:700;text-align:right;color:#16a34a">+${g.fadeEV.toFixed(2)}% EV · ${g.fadeKelly.toFixed(1)}% ($${((g.fadeKelly / 100) * bankroll).toFixed(0)})</td>
      </tr>
    </table>
  </div>
  ` : ''}

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

  ${(() => {
    // ─── PLAYER PROPS SECTION ──────────────────────────────────────────────
    // Aggregate all prop edges across every game, sort by EV, show top 10
    const allProps = analyzed.flatMap(g =>
      (g.propEdges || []).map(p => ({ ...p, matchup: `${g.awayTeam} @ ${g.homeTeam}` }))
    ).sort((a, b) => b.ev - a.ev).slice(0, 10);

    if (allProps.length === 0) {
      return `<div style="background:#f9fafb;border-radius:12px;padding:20px;text-align:center;color:#9ca3af;font-size:13px;margin-bottom:20px">
        🎯 No +EV player props detected today (Vegas lines tight or none available)
      </div>`;
    }

    const propRows = allProps.map((p, i) => {
      const typeIcon = p.type === 'pitcher_ks' ? '⚾' : '🥎';
      const typeLabel = p.type === 'pitcher_ks' ? 'PITCHER K' : 'BATTER HITS';
      const evColor = p.ev > 7 ? '#16a34a' : p.ev > 4 ? '#65a30d' : '#ca8a04';
      const isBest = i === 0;
      return `
      <tr style="background:${isBest ? '#f0fdf4' : (i % 2 ? '#fafafa' : '#fff')};border-bottom:1px solid #e5e7eb">
        <td style="padding:10px 8px;font-size:11px;color:#6b7280">${typeIcon}<br><span style="font-size:9px;letter-spacing:0.5px">${typeLabel}</span></td>
        <td style="padding:10px 8px">
          <div style="font-weight:700;font-size:13px;color:#111827">${p.pick}</div>
          <div style="font-size:11px;color:#6b7280">${p.matchup} · ${p.bookmaker}</div>
        </td>
        <td style="padding:10px 8px;text-align:center;font-size:12px">
          <div style="font-weight:700;color:#1d4ed8">${fmtOdds(p.odds)}</div>
          <div style="font-size:10px;color:#9ca3af">Vegas</div>
        </td>
        <td style="padding:10px 8px;text-align:center;font-size:12px">
          <div style="font-weight:700">${p.simProb}%</div>
          <div style="font-size:10px;color:#9ca3af">vs ${p.impliedProb}%</div>
        </td>
        <td style="padding:10px 8px;text-align:center;font-size:13px;font-weight:800;color:${evColor}">
          +${p.ev}%
          <div style="font-size:10px;color:#9ca3af;font-weight:600">${p.kelly}% bnk</div>
        </td>
      </tr>`;
    }).join('');

    return `
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:0;margin-bottom:20px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#1e40af,#3730a3);color:#fff;padding:16px 20px">
        <div style="font-size:18px;font-weight:800;letter-spacing:0.5px">🎯 PLAYER PROP EDGES</div>
        <div style="font-size:11px;color:#bfdbfe;margin-top:4px">Top ${allProps.length} +EV props · Pitcher K + Batter Hits · Sim probabilities from MLB Stats API + Vegas lines</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:#f3f4f6;border-bottom:2px solid #d1d5db">
            <th style="padding:8px;text-align:left;font-size:10px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase">Type</th>
            <th style="padding:8px;text-align:left;font-size:10px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase">Pick</th>
            <th style="padding:8px;text-align:center;font-size:10px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase">Odds</th>
            <th style="padding:8px;text-align:center;font-size:10px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase">Sim/Vegas</th>
            <th style="padding:8px;text-align:center;font-size:10px;color:#6b7280;letter-spacing:0.5px;text-transform:uppercase">EV / Kelly</th>
          </tr>
        </thead>
        <tbody>${propRows}</tbody>
      </table>
    </div>`;
  })()}

  <div style="text-align:center;color:#9ca3af;font-size:11px;padding:16px;line-height:1.8">
    Powered by MLB Stats API · 10M Poisson sims · Pitching-first model: starter ERA/FIP/WHIP/K9 + rest days + bullpen fatigue + lineup OBP/SLG · Kelly capped at 25%<br>
    Props: 200k sims per pitcher line, 50k sims per batter line · The Odds API for Vegas prop lines<br>
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

  // 2. Fetch odds (moneyline + totals)
  const oddsData = await fetchOdds(ODDS_API_KEY);
  console.log(`Odds API: ${oddsData.length} games`);

  // 2b. Fetch event list (needed for per-event prop endpoints)
  const events = await fetchEventList(ODDS_API_KEY);
  console.log(`Events API: ${events.length} events`);

  // 3. Build game data with real pitcher + team stats
  console.log('Fetching pitcher & team stats from MLB Stats API...');
  const games = await buildGameData(schedule);

  // 4. Attach moneyline odds, totals, AND player props to each game
  for (const g of games) {
    const odds = matchOdds(g, oddsData);
    g.homeOdds = odds.homeOdds;
    g.awayOdds = odds.awayOdds;
    g.vegasOULine = odds.ouLine;
    g.bookmaker = odds.bookmaker;

    // Match this game to an event ID and fetch player props
    const event = matchEvent(g, events);
    if (event?.id) {
      const propData = await fetchEventProps(ODDS_API_KEY, event.id);
      const props = extractProps(propData);
      g.props = props;
      console.log(`  Props for ${g.awayTeam} @ ${g.homeTeam}: ${props.pitcherKs.length} K-lines, ${props.batterHits.length} hit-lines`);

      // For batter prop simulation, we need individual batter stats keyed by ID.
      // Pull stats for everyone in the lineup who has a batter prop offered.
      const allBatterIds = [
        ...(g.lineupIds?.home || []),
        ...(g.lineupIds?.away || []),
      ];
      const batterStats = {};
      // Only fetch when batter props exist (avoid wasted API calls)
      if (props.batterHits.length > 0 && allBatterIds.length > 0) {
        const results = await Promise.all(allBatterIds.map(id => fetchBatterStats(id)));
        allBatterIds.forEach((id, idx) => { if (results[idx]) batterStats[id] = results[idx]; });
      }
      g.batterStats = batterStats;
    } else {
      g.props = { pitcherKs: [], batterHits: [] };
      g.batterStats = {};
    }
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
