const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'season-database.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = 30;  // keep last 30 daily snapshots
const MAX_HOURLY_BACKUPS = 10;  // keep last 10 hourly emergency backups

// ─── Backup System ────────────────────────────────────────────────────────────
// Strategy: before every write, snapshot the current DB to data/backups/.
// Daily snapshots are kept for 30 days. Hourly emergency snapshots keep the
// last 10. The combination protects against:
//   1. Accidental deletion / git mishap (daily snapshots)
//   2. Code bug that corrupts the DB (hourly snapshots — quick rollback window)
//   3. Mid-write crash (atomic writes via temp file + rename)
function backupDB() {
  if (!fs.existsSync(DB_FILE)) return null;
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS

    // Daily snapshot (one per day, overwrites earlier same-day writes)
    const dailyPath = path.join(BACKUP_DIR, `daily-${dateStr}.json`);
    fs.copyFileSync(DB_FILE, dailyPath);

    // Hourly snapshot (timestamped, every save creates a new one for last-N retention)
    const hourlyPath = path.join(BACKUP_DIR, `snapshot-${timeStr}.json`);
    fs.copyFileSync(DB_FILE, hourlyPath);

    // Prune old backups
    pruneBackups();
    return { dailyPath, hourlyPath };
  } catch(e) {
    console.error('Backup failed (non-fatal):', e.message);
    return null;
  }
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR);
    // Prune daily snapshots — keep last MAX_BACKUPS
    const dailies = files
      .filter(f => f.startsWith('daily-') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(BACKUP_DIR, f) }))
      .sort((a, b) => b.name.localeCompare(a.name));
    dailies.slice(MAX_BACKUPS).forEach(f => fs.unlinkSync(f.path));
    // Prune hourly snapshots — keep last MAX_HOURLY_BACKUPS
    const snapshots = files
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .map(f => ({ name: f, path: path.join(BACKUP_DIR, f) }))
      .sort((a, b) => b.name.localeCompare(a.name));
    snapshots.slice(MAX_HOURLY_BACKUPS).forEach(f => fs.unlinkSync(f.path));
  } catch(e) {
    console.error('Prune failed (non-fatal):', e.message);
  }
}

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
  // ATOMIC WRITE — write to temp file first, then rename. If we crash mid-write,
  // the original file stays intact. fs.renameSync is atomic on POSIX systems.
  backupDB();
  const tempFile = DB_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
  fs.renameSync(tempFile, DB_FILE);
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
      // Player prop edges — track each +EV prop for backtesting
      prop_edges: (p.propEdges || []).map(edge => ({
        type: edge.type,
        pick: edge.pick,
        player: edge.player,
        line: edge.line,
        side: edge.side,
        odds: edge.odds,
        sim_prob: edge.simProb,
        implied_prob: edge.impliedProb,
        ev: edge.ev,
        kelly: edge.kelly,
        bookmaker: edge.bookmaker,
        result: 'pending',  // will be settled by morning summary
      })),
      result: 'pending',
      home_score: null,
      away_score: null,
      final_result_str: null,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      // Preserve settled main result + settled props
      if (existing.result && existing.result !== 'pending') {
        entry.result = existing.result;
        entry.home_score = existing.home_score;
        entry.away_score = existing.away_score;
        entry.final_result_str = existing.final_result_str;
      }
      // Merge prop results: keep settled, update pending
      if (existing.prop_edges && entry.prop_edges) {
        for (const newProp of entry.prop_edges) {
          const oldProp = existing.prop_edges.find(op =>
            op.pick === newProp.pick && op.line === newProp.line && op.side === newProp.side
          );
          if (oldProp && oldProp.result && oldProp.result !== 'pending') {
            newProp.result = oldProp.result;
            newProp.actual = oldProp.actual;
          }
        }
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
  for (const s of scores) {
    const homeMatch = s.home?.includes(game.home_team?.split(' ').pop()) ||
                      game.home_team?.includes(s.home?.split(' ').pop());
    const awayMatch = s.away?.includes(game.away_team?.split(' ').pop()) ||
                      game.away_team?.includes(s.away?.split(' ').pop());
    if (homeMatch && awayMatch) return s;
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
