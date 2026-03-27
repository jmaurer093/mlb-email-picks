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
        catch(e) { reject(new Error('JSON parse failed: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('JSON parse failed: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function fmtOdds(o) { return o > 0 ? `+${o}` : `${o}`; }
function dec(o) { return o > 0 ? o/100+1 : 100/Math.abs(o)+1; }

function getTimeLabel() {
  const hour = new Date().getUTCHours();
  if (hour >= 14 && hour < 17) return 'Noon';
  if (hour >= 17 && hour < 20) return '3 PM';
  return '6 PM';
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function ensureDataDir() {
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function fetchESPN() {
  const today = new Date();
  const ymd = today.getUTCFullYear() +
    String(today.getUTCMonth()+1).padStart(2,'0') +
    String(today.getUTCDate()).padStart(2,'0');
  try {
    const data = await httpsGet(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${ymd}`);
    return (data.events || []).map(e => ({
      name: e.name,
      date: e.date,
      status: e.status?.type?.description,
      competitors: e.competitions?.[0]?.competitors?.map(c => ({
        team: c.team?.displayName,
        abbr: c.team?.abbreviation,
        homeAway: c.homeAway,
        record: c.records?.[0]?.summary,
        pitcher: c.probables?.[0]?.displayName,
      }))
    }));
  } catch(e) {
    console.log('ESPN fetch failed:', e.message);
    return [];
  }
}

async function getAnalysis(espnEvents, anthropicKey) {
  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York'
  });

  const espnSection = espnEvents.length
    ? `ESPN data (${espnEvents.length} games):\n${JSON.stringify(espnEvents, null, 2)}`
    : `No ESPN data available. Today is ${todayLabel}. Use your knowledge of today's full MLB schedule.`;

  const prompt = `You are an expert MLB betting analyst. Today is ${todayLabel}.

${espnSection}

Use your knowledge of current MLB team performance, starting pitchers, recent form, and typical Vegas lines to estimate realistic odds and analyze every game on today's slate for +EV betting opportunities.

Return ONLY a valid JSON array, no markdown, no explanation:
[{
  "home_team": "full team name",
  "away_team": "full team name",
  "commence_time": "e.g. 1:05 PM ET",
  "pick": "team name to
