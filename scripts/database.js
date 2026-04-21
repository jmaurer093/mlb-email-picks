const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'season-database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const empty = {
      meta: { created: new Date().toISOString(), season: 2026, start_date: '2026-03-30' },
      season_stats: { wins: 0, losses: 0, pushes: 0, pending: 0, profit: 0, roi: 0, total_wagered: 0 },
      games: {}
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Save predictions for a given date
function savePredictions(date, predictions) {
  const db = loadDB();
  if (!db.games[date]) db.games[date] = [];

  for (const p of predictions) {
    // Support both camelCase (from analyzeGame) and snake_case (normalized)
    const homeTeam = p.homeTeam || p.home_team;
    const awayTeam = p.awayTeam || p.away_team;

    const existing = db.games[date].find(g =>
      g.home_team === homeTeam && g.away_team === awayTeam
    );
    const entry = {
      date,
      matchup: `${awayTeam} @ ${homeTeam}`,
      home_team: homeTeam,
      away_team: awayTeam,
      game_time: p.commence_time || p.gameTime || 'TBD',
      pick: p.pick,
      pick_odds: p.pickOdds,
      ev_pct: parseFloat((p.ev || 0).toFixed(2)),
      kelly_pct: parseFloat((p.kelly || 0).toFixed(2)),
      confidence_score: p.confidenceScore || null,
      sim_home_win_pct: p.sim?.homeWinPct ?? null,
      sim_away_win_pct: p.sim?.awayWinPct ?? null,
      ci_low: p.sim?.ciLow ?? null,
      ci_high: p.sim?.ciHigh ?? null,
      projected_total: p.sim?.projectedTotal ?? null,
      projected_f5: p.sim?.projectedF5Total ?? null,
      vegas_ou: p.vegasOULine ?? null,
      home_pitcher: p.homePitcherName || null,
      away_pitcher: p.awayPitcherName || null,
      home_era: p.homeStats?.starterERA ?? null,
      away_era: p.awayStats?.starterERA ?? null,
      home_plate_ump: p.homePlateUmp || null,
      ump_factor: p.umpFactor ?? null,
      result: 'pending',
      home_score: null,
      away_score: null,
      final_result_str: null,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      // Preserve result/score if already settled — don't reset W/L back to pending
      if (existing.result && existing.result !== 'pending') {
        entry.result = existing.result;
        entry.home_score = existing.home_score;
        entry.away_score = existing.away_score;
        entry.final_result_str = existing.final_result_str;
      }
      Object.assign(existing, entry);
    } else {
      db.games[date].push(entry);
    }
  }

  saveDB(db);
  console.log(`DB: Saved ${predictions.length} predictions for ${date}`);
}

// Update results for a given date from ESPN scores
function updateResults(date, scores) {
  const db = loadDB();
  if (!db.games[date]) { console.log(`DB: No games found for ${date}`); return 0; }

  let updated = 0;
  for (const game of db.games[date]) {
    if (game.result !== 'pending') continue;
    const score = findScore(game, scores);
    if (!score) continue;

    const homeWon = score.homeScore > score.awayScore;
    const tie = score.homeScore === score.awayScore;
    const pickWon = game.pick === game.home_team ? homeWon : !homeWon;

    game.result = tie ? 'P' : pickWon ? 'W' : 'L';
    game.home_score = score.homeScore;
    game.away_score = score.awayScore;
    game.final_result_str = `${game.away_team} ${score.awayScore}, ${game.home_team} ${score.homeScore}`;
    game.updated_at = new Date().toISOString();
    updated++;
  }

  // Recalculate season stats
  recalcStats(db);
  saveDB(db);
  console.log(`DB: Updated ${updated} results for ${date}`);
  return updated;
}

function findScore(game, scores) {
  // Try two-word match first (e.g. "Red Sox", "Blue Jays") — prevents Sox/Sox confusion
  for (const s of scores) {
    const homeKey = game.home_team?.split(' ').slice(-2).join(' ').toLowerCase();
    const awayKey = game.away_team?.split(' ').slice(-2).join(' ').toLowerCase();
    const sHome = s.home?.toLowerCase() || '';
    const sAway = s.away?.toLowerCase() || '';
    if (sHome.includes(homeKey) && sAway.includes(awayKey)) return s;
    if (homeKey && sHome.includes(homeKey) && awayKey && sAway.includes(awayKey)) return s;
  }
  // Fallback: single last word, but require BOTH to match
  for (const s of scores) {
    const homeLast = game.home_team?.split(' ').pop()?.toLowerCase();
    const awayLast = game.away_team?.split(' ').pop()?.toLowerCase();
    const sHome = s.home?.toLowerCase() || '';
    const sAway = s.away?.toLowerCase() || '';
    if (homeLast && awayLast && sHome.includes(homeLast) && sAway.includes(awayLast)) return s;
  }
  return null;
}

function recalcStats(db) {
  let wins = 0, losses = 0, pushes = 0, pending = 0, profit = 0, wagered = 0;
  const bankroll = 1000;

  for (const date of Object.keys(db.games)) {
    for (const g of db.games[date]) {
      const bet = (g.kelly_pct / 100) * bankroll;
      if (g.result === 'W') {
        wins++;
        const d = g.pick_odds > 0 ? g.pick_odds / 100 + 1 : 100 / Math.abs(g.pick_odds) + 1;
        profit += (d - 1) * bet;
        wagered += bet;
      } else if (g.result === 'L') {
        losses++;
        profit -= bet;
        wagered += bet;
      } else if (g.result === 'P') {
        pushes++;
      } else {
        pending++;
      }
    }
  }

  const total = wins + losses;
  db.season_stats = {
    wins, losses, pushes, pending,
    profit: parseFloat(profit.toFixed(2)),
    total_wagered: parseFloat(wagered.toFixed(2)),
    roi: wagered > 0 ? parseFloat(((profit / wagered) * 100).toFixed(2)) : 0,
    win_pct: total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0,
    record: `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ''}`,
  };
}

function getDateGames(date) {
  const db = loadDB();
  return db.games[date] || [];
}

function getAllGames() {
  const db = loadDB();
  return db.games;
}

function getSeasonStats() {
  const db = loadDB();
  return db.season_stats;
}

function getDB() {
  return loadDB();
}

module.exports = { savePredictions, updateResults, getDateGames, getAllGames, getSeasonStats, getDB, recalcStats, saveDB, loadDB };
