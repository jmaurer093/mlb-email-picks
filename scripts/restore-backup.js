#!/usr/bin/env node
/**
 * Restore season database from a backup snapshot.
 *
 * Usage:
 *   node scripts/restore-backup.js                  # list available backups
 *   node scripts/restore-backup.js latest           # restore from most recent
 *   node scripts/restore-backup.js daily-2026-04-21 # restore specific backup
 *   node scripts/restore-backup.js --dry-run latest # preview without restoring
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'season-database.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log('No backups directory found at:', BACKUP_DIR);
    return [];
  }
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const fullPath = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fullPath);
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      const gameCount = Object.values(data.games || {}).reduce((s, arr) => s + arr.length, 0);
      const dateCount = Object.keys(data.games || {}).length;
      const stats = data.season_stats || {};
      return {
        name: f,
        path: fullPath,
        size: stat.size,
        mtime: stat.mtime,
        gameCount,
        dateCount,
        record: `${stats.wins || 0}W-${stats.losses || 0}L`,
        profit: stats.profit || 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files;
}

function showList() {
  const backups = listBackups();
  if (backups.length === 0) {
    console.log('No backups available.');
    return;
  }
  console.log(`\nAvailable backups (${backups.length}):\n`);
  console.log(' Filename'.padEnd(45) + ' Modified'.padEnd(22) + 'Games  Record    P&L');
  console.log('─'.repeat(95));
  for (const b of backups) {
    const modStr = b.mtime.toISOString().slice(0, 16).replace('T', ' ');
    const nameShort = b.name.length > 42 ? b.name.slice(0, 39) + '...' : b.name;
    console.log(
      ` ${nameShort.padEnd(43)} ${modStr.padEnd(20)} ${String(b.gameCount).padStart(4)}  ${b.record.padEnd(8)} $${b.profit}`
    );
  }
  console.log('\nTo restore: node scripts/restore-backup.js <filename>');
  console.log('Or use:     node scripts/restore-backup.js latest');
}

function restore(target, dryRun = false) {
  const backups = listBackups();
  if (backups.length === 0) {
    console.error('No backups available to restore from.');
    process.exit(1);
  }

  let chosen;
  if (target === 'latest') {
    chosen = backups[0];
  } else {
    const name = target.endsWith('.json') ? target : target + '.json';
    chosen = backups.find(b => b.name === name);
    if (!chosen) {
      console.error(`Backup not found: ${name}`);
      console.error('Run without arguments to list available backups.');
      process.exit(1);
    }
  }

  console.log(`\nSelected backup: ${chosen.name}`);
  console.log(`Modified:        ${chosen.mtime.toISOString()}`);
  console.log(`Contents:        ${chosen.gameCount} games across ${chosen.dateCount} dates`);
  console.log(`Record:          ${chosen.record}, P&L: $${chosen.profit}`);

  if (dryRun) {
    console.log('\n[DRY RUN] Would copy backup to:', DB_FILE);
    return;
  }

  // Safety: snapshot current DB before restoring (call it pre-restore)
  if (fs.existsSync(DB_FILE)) {
    const safetyName = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    const safetyPath = path.join(BACKUP_DIR, safetyName);
    fs.copyFileSync(DB_FILE, safetyPath);
    console.log(`\n✓ Current DB backed up as: ${safetyName}`);
  }

  fs.copyFileSync(chosen.path, DB_FILE);
  console.log(`✓ Restored ${chosen.name} → ${DB_FILE}`);
  console.log('\nCommit and push:');
  console.log('  git add data/season-database.json data/backups/');
  console.log('  git commit -m "Restore from backup"');
  console.log('  git push');
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.filter(a => !a.startsWith('--'))[0];

if (!target) {
  showList();
} else {
  restore(target, dryRun);
}
