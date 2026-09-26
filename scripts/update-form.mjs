#!/usr/bin/env node
// Haalt via API-Football de groepsindeling van de UEFA Nations League op en
// per land de laatste 5 gespeelde interlands (alle competities). Schrijft het
// resultaat naar data/form.json en data/form.js (dat laatste werkt ook vanaf file://).
//
// Gebruik:
//   API_FOOTBALL_KEY=xxx node scripts/update-form.mjs          # alleen verversen als er gisteren gespeeld is
//   API_FOOTBALL_KEY=xxx node scripts/update-form.mjs --force  # altijd verversen
//
// Optionele omgevingsvariabelen:
//   NL_SEASON         seizoen van de Nations League (standaard 2026 = 2026-27)
//   REQUEST_DELAY_MS  pauze tussen API-verzoeken (standaard 6500 ms, gratis plan = max 10 per minuut)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://v3.football.api-sports.io';
const NATIONS_LEAGUE_ID = 5;
const TIMEZONE = 'Europe/Amsterdam';
const FORM_LENGTH = 5;
const FINISHED = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = join(ROOT, 'data', 'form.json');
const JS_PATH = join(ROOT, 'data', 'form.js');

const API_KEY = process.env.API_FOOTBALL_KEY;
const SEASON = Number(process.env.NL_SEASON || 2026);
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 6500);
const FORCE = process.argv.includes('--force') || process.env.FORCE === 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;
async function api(path, params) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (requestCount > 0) await sleep(DELAY_MS);
    requestCount++;
    const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
    if (res.status === 429) {
      console.warn(`429 op ${url.pathname}, opnieuw proberen na 60s...`);
      await sleep(60_000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} op ${url}`);
    const body = await res.json();
    const errors = body.errors && Object.keys(body.errors).length ? body.errors : null;
    if (errors) {
      if (errors.rateLimit && attempt < 3) {
        console.warn('Rate limit bereikt, opnieuw proberen na 60s...');
        await sleep(60_000);
        continue;
      }
      throw new Error(`API-fout op ${url.pathname}${url.search}: ${JSON.stringify(errors)}`);
    }
    return body.response;
  }
  throw new Error(`Te vaak geweigerd door rate limit: ${url}`);
}

// Datum (YYYY-MM-DD) in Nederlandse tijd, met offset in dagen.
function amsterdamDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);
}

async function readExisting() {
  try {
    return JSON.parse(await readFile(JSON_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// "League A - Group 1", "League A: Group 1", "Liga A Grupo 1" -> { league: 'A', group: 1 }
function parseGroupName(name) {
  const m = /(?:League|Liga)\s*([A-D])\b.*?(?:Group|Grupo)\s*(\d)/i.exec(name || '');
  return m ? { league: m[1].toUpperCase(), group: Number(m[2]) } : null;
}

async function fetchGroups() {
  const response = await api('/standings', { league: NATIONS_LEAGUE_ID, season: SEASON });
  const tables = response?.[0]?.league?.standings ?? [];
  const leagues = {};
  const seen = [];

  for (const table of tables) {
    const groupName = table[0]?.group;
    seen.push(groupName);
    const parsed = parseGroupName(groupName);
    if (!parsed) continue;
    const key = `${parsed.league}${parsed.group}`;
    (leagues[parsed.league] ??= {})[key] = table.map((row) => ({
      id: row.team.id,
      name: row.team.name,
      logo: row.team.logo,
    }));
  }

  if (!Object.keys(leagues).length) {
    throw new Error(`Geen groepen herkend in standings (seizoen ${SEASON}). Gevonden: ${JSON.stringify(seen)}`);
  }
  return leagues;
}

function toMatch(fixture, teamId) {
  const isHome = fixture.teams.home.id === teamId;
  const them = isHome ? fixture.teams.away : fixture.teams.home;
  const gf = isHome ? fixture.goals.home : fixture.goals.away;
  const ga = isHome ? fixture.goals.away : fixture.goals.home;
  if (gf == null || ga == null) return null;

  // Uitslag na 90/120 minuten; een strafschoppenserie telt als gelijkspel.
  const result = gf > ga ? 'W' : gf < ga ? 'L' : 'D';

  return {
    date: fixture.fixture.date,
    competition: fixture.league.name,
    home: isHome,
    opponent: them.name,
    opponentLogo: them.logo,
    gf,
    ga,
    status: fixture.fixture.status.short,
    result,
  };
}

async function fetchForm(team) {
  // Vraag er iets meer op dan 5, zodat afgelaste/gestaakte duels eruit gefilterd kunnen worden.
  const fixtures = await api('/fixtures', { team: team.id, last: 10, timezone: TIMEZONE });
  const matches = fixtures
    .filter((f) => FINISHED.has(f.fixture.status.short))
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
    .map((f) => toMatch(f, team.id))
    .filter(Boolean)
    .slice(0, FORM_LENGTH);

  const points = matches.reduce((s, m) => s + (m.result === 'W' ? 3 : m.result === 'D' ? 1 : 0), 0);
  const goalsFor = matches.reduce((s, m) => s + m.gf, 0);
  const goalsAgainst = matches.reduce((s, m) => s + m.ga, 0);
  return { ...team, points, goalsFor, goalsAgainst, goalDiff: goalsFor - goalsAgainst, matches };
}

// Punten > doelsaldo > doelpunten voor > naam.
function rank(teams) {
  return [...teams].sort(
    (a, b) =>
      b.points - a.points ||
      b.goalDiff - a.goalDiff ||
      b.goalsFor - a.goalsFor ||
      a.name.localeCompare(b.name),
  );
}

async function playedYesterday(teamIds) {
  const date = amsterdamDate(-1);
  const fixtures = await api('/fixtures', { date, timezone: TIMEZONE });
  const hits = fixtures.filter(
    (f) =>
      FINISHED.has(f.fixture.status.short) &&
      (teamIds.has(f.teams.home.id) || teamIds.has(f.teams.away.id)),
  );
  for (const f of hits) console.log(`  ${date}: ${f.teams.home.name} ${f.goals.home}-${f.goals.away} ${f.teams.away.name}`);
  return hits.length > 0;
}

async function main() {
  if (!API_KEY) {
    console.error('API_FOOTBALL_KEY ontbreekt. Zet deze als omgevingsvariabele of GitHub-secret.');
    process.exit(1);
  }

  const existing = await readExisting();
  if (!FORCE && existing?.leagues) {
    const ids = new Set(
      Object.values(existing.leagues).flatMap((groups) => Object.values(groups).flatMap((g) => g.map((t) => t.id))),
    );
    console.log(`Controleren of een van de ${ids.size} landen gisteren heeft gespeeld...`);
    if (!(await playedYesterday(ids))) {
      console.log('Geen wedstrijden gisteren: dashboard blijft ongewijzigd.');
      return;
    }
  }

  console.log(`Groepsindeling ophalen (seizoen ${SEASON})...`);
  const groups = await fetchGroups();

  const leagues = {};
  for (const [league, leagueGroups] of Object.entries(groups).sort()) {
    leagues[league] = {};
    for (const [key, teams] of Object.entries(leagueGroups).sort()) {
      const withForm = [];
      for (const team of teams) {
        console.log(`  ${key}: ${team.name}`);
        withForm.push(await fetchForm(team));
      }
      leagues[league][key] = rank(withForm);
    }
  }

  const data = {
    updatedAt: new Date().toISOString(),
    season: `${SEASON}-${String(SEASON + 1).slice(2)}`,
    formLength: FORM_LENGTH,
    leagues,
  };

  await mkdir(dirname(JSON_PATH), { recursive: true });
  await writeFile(JSON_PATH, JSON.stringify(data, null, 2) + '\n');
  await writeFile(JS_PATH, `window.FORM_DATA = ${JSON.stringify(data)};\n`);
  console.log(`Klaar: ${requestCount} API-verzoeken, data weggeschreven naar data/form.json en data/form.js.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
