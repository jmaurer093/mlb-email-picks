/**
 * Player prop simulation module.
 *
 * Plug in by calling `simulatePitcherKs(pitcher, opposingTeam, N)` or
 * `simulateBatterProp(batter, pitcher, prop, N)` from analyzeGame.
 *
 * EXPORTS:
 *   simulatePitcherKs(pitcher, opp, opts)     → { mean, p_over: {4.5: x, 5.5: y, ...} }
 *   simulateBatterHits(batter, pitcher, opts) → { mean, p_over: {0.5: x, 1.5: y, ...} }
 *   simulateBatterHR(batter, pitcher, opts)   → { p_hr_at_least_one }
 */

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

/**
 * Simulate a starter's strikeout total.
 * pitcher: { k9, ip, recentERA, expectedIP (~6.0 default) }
 * opp: { teamK_rate ~ league avg 0.224, teamOPS, lineupVsHandSLG }
 */
function simulatePitcherKs(pitcher, opp = {}, opts = {}) {
  const { N = 200000, lines = [3.5, 4.5, 5.5, 6.5, 7.5, 8.5] } = opts;
  const k9 = pitcher.starterK9 ?? pitcher.k9 ?? 8.5;
  const expectedIP = pitcher.expectedIP ?? 6.0;
  // K rate adjustment based on opposing team contact ability
  // High-OPS lineups put more balls in play, slightly lower K rate
  const oppOPS = (opp.teamOBP ?? 0.320) + (opp.teamSLG ?? 0.400);
  const oppKAdj = oppOPS > 0.770 ? 0.92 : oppOPS < 0.700 ? 1.08 : 1.0;
  const baseLambda = (k9 / 9) * expectedIP * oppKAdj;

  let sum = 0;
  const overCounts = {};
  for (const l of lines) overCounts[l] = 0;

  for (let i = 0; i < N; i++) {
    const k = poissonSample(baseLambda);
    sum += k;
    for (const l of lines) if (k > l) overCounts[l]++;
  }
  const p_over = {};
  for (const l of lines) p_over[l] = +(overCounts[l] / N * 100).toFixed(1);
  return {
    mean: +(sum / N).toFixed(2),
    p_over,
    lambda: +baseLambda.toFixed(2),
  };
}

/**
 * Simulate a single batter's hit total.
 * batter: { obp, slg, avg }
 * pitcher: { whip, k9, throws, era }
 * Returns expected hits distribution across ~4.2 PAs/game.
 */
function simulateBatterHits(batter, pitcher = {}, opts = {}) {
  const { N = 100000, lines = [0.5, 1.5, 2.5] } = opts;
  const avg = batter.avg ?? 0.250;
  const expectedPA = 4.2;
  // Pitcher quality adjustment — better pitcher = lower batter AVG
  const pERA = pitcher.starterERA ?? pitcher.era ?? 4.20;
  const pitcherAdj = 4.20 / Math.max(2.0, pERA); // ratio: 4.20 ERA = neutral
  const adjAvg = Math.min(0.450, avg * pitcherAdj);

  let sum = 0;
  const overCounts = {};
  for (const l of lines) overCounts[l] = 0;

  for (let i = 0; i < N; i++) {
    let hits = 0;
    for (let j = 0; j < expectedPA; j++) {
      if (Math.random() < adjAvg) hits++;
    }
    sum += hits;
    for (const l of lines) if (hits > l) overCounts[l]++;
  }
  const p_over = {};
  for (const l of lines) p_over[l] = +(overCounts[l] / N * 100).toFixed(1);
  return {
    mean: +(sum / N).toFixed(2),
    p_over,
    adjAvg: +adjAvg.toFixed(3),
  };
}

/**
 * Probability of batter hitting at least one HR.
 */
function simulateBatterHR(batter, pitcher = {}, opts = {}) {
  const { N = 100000 } = opts;
  // League HR rate per PA ≈ 0.035. Adjust by batter SLG vs avg SLG (0.400).
  const slg = batter.slg ?? 0.400;
  const baseHRpPA = 0.035 * (slg / 0.400);
  const pHR9 = pitcher.starterFIP
    ? Math.max(0.5, 13 * 9 / Math.max(2, pitcher.starterFIP * 9 - 3 * (pitcher.starterBB9 || 3) + 2 * (pitcher.starterK9 || 8.5)) / 9)
    : 1.2;
  const pitcherAdj = Math.min(1.4, Math.max(0.7, pHR9 / 1.2));
  const adjHRpPA = baseHRpPA * pitcherAdj;
  const expectedPA = 4.2;

  let atLeastOne = 0;
  for (let i = 0; i < N; i++) {
    let hr = false;
    for (let j = 0; j < expectedPA; j++) {
      if (Math.random() < adjHRpPA) { hr = true; break; }
    }
    if (hr) atLeastOne++;
  }
  return {
    p_hr_at_least_one: +(atLeastOne / N * 100).toFixed(2),
    adjHRpPA: +adjHRpPA.toFixed(4),
  };
}

module.exports = { simulatePitcherKs, simulateBatterHits, simulateBatterHR };
