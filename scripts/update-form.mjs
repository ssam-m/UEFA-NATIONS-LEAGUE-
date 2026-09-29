#!/usr/bin/env node
// Haalt via de openbare ESPN-API de groepsindeling van de UEFA Nations League op en
// per land de laatste 5 gespeelde interlands (alle competities). Schrijft het
// resultaat naar data/form.json en data/form.js (dat laatste werkt ook vanaf file://).
//
// Gebruik:
//   node scripts/update-form.mjs          # alleen verversen als er gisteren gespeeld is
//   node scripts/update-form.mjs --force  # altijd verversen
//
// Optionele omgevingsvariabelen:
//   NL_SEASON         seizoen van de Nations League (standaard 2026 = 2026-27)
//   REQUEST_DELAY_MS  pauze tussen API-verzoeken (standaard 150 ms)
//
// Let op: de ESPN-API is openbaar maar officieus (niet gedocumenteerd). Het script
// logt daarom veel, zodat je in de log van de workflow kunt zien wat er gevonden is.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://site.api.espn.com/apis';
const STANDINGS_LEAGUE = 'uefa.nations';
// Competities waarin landenteams spelen, met de Nederlandse naam voor op het dashboard.
const COMPETITIONS = {
  'uefa.nations': 'Nations League',
  'fifa.friendly': 'Vriendschappelijk',
  'fifa.world': 'WK',
  'fifa.worldq.uefa': 'WK-kwalificatie',
  'uefa.euro': 'EK',
  'uefa.euroq': 'EK-kwalificatie',
};
const TIMEZONE = 'Europe/Amsterdam';
const FORM_LENGTH = 5;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = join(ROOT, 'data', 'form.json');
const JS_PATH = join(ROOT, 'data', 'form.js');

const SEASON = Number(process.env.NL_SEASON || 2026);
const DELAY_MS = Number(process.env.REQUEST_DELAY_MS ?? 150);
const FORCE = process.argv.includes('--force') || process.env.FORCE === 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;
// Geeft de JSON terug, of null bij 404 (bijv. een competitie zonder data voor dat seizoen).
async function api(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (requestCount > 0) await sleep(DELAY_MS);
    requestCount++;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`HTTP ${res.status} op ${url}`);
      console.warn(`HTTP ${res.status} op ${url.pathname}, poging ${attempt}/3`);
    } catch (err) {
      if (attempt === 3 || /HTTP 4/.test(err.message)) throw err;
      console.warn(`Netwerkfout op ${url.pathname} (${err.message}), poging ${attempt}/3`);
    }
    await sleep(2000 * attempt);
  }
  throw new Error(`Geen antwoord van ${url}`);
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

// Herkent namen als "League A Group 1", "League A - Group 1", "Group A1" of "A1".
function parseGroupName(name) {
  const s = name || '';
  const league = /(?:League|Liga)\s*([A-D])\b/i.exec(s)?.[1];
  const group = /(?:Group|Grupo)\s*(?:[A-D]\s*)?(\d)\b/i.exec(s)?.[1];
  if (league && group) return { league: league.toUpperCase(), group: Number(group) };
  const short = /\b([A-D])\s*-?\s*(\d)\b/.exec(s);
  return short ? { league: short[1].toUpperCase(), group: Number(short[2]) } : null;
}

// Loopt de (mogelijk geneste) standings-structuur af en geeft elke tabel met zijn volledige pad-naam.
function collectTables(node, path = []) {
  const name = node.name || node.abbreviation || '';
  const here = name ? [...path, name] : path;
  const tables = [];
  if (node.standings?.entries?.length) tables.push({ name: here.join(' / '), entries: node.standings.entries });
  for (const child of node.children || []) tables.push(...collectTables(child, here));
  return tables;
}

function teamInfo(team) {
  return {
    id: String(team.id),
    name: team.displayName || team.name || team.shortDisplayName,
    logo: team.logos?.[0]?.href || team.logo || '',
  };
}

async function fetchGroups() {
  let body = await api(`/v2/sports/soccer/${STANDINGS_LEAGUE}/standings`, { season: SEASON });
  let tables = body ? collectTables(body) : [];
  if (!tables.length) {
    console.log('  Geen tabellen met seizoen-parameter, opnieuw zonder...');
    body = await api(`/v2/sports/soccer/${STANDINGS_LEAGUE}/standings`);
    tables = body ? collectTables(body) : [];
  }

  const leagues = {};
  for (const table of tables) {
    const parsed = parseGroupName(table.name);
    console.log(`  Tabel "${table.name}" -> ${parsed ? parsed.league + parsed.group : 'niet herkend'} (${table.entries.length} landen)`);
    if (!parsed) continue;
    (leagues[parsed.league] ??= {})[`${parsed.league}${parsed.group}`] = table.entries.map((e) => teamInfo(e.team));
  }

  if (!Object.keys(leagues).length) {
    throw new Error(`Geen groepen herkend in de standings (seizoen ${SEASON}). Gevonden tabellen: ${JSON.stringify(tables.map((t) => t.name))}`);
  }
  return leagues;
}

const scoreOf = (c) => {
  const v = typeof c.score === 'object' && c.score !== null ? (c.score.value ?? c.score.displayValue) : c.score;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isCompleted = (competition) => {
  const type = competition?.status?.type || {};
  return type.completed === true || type.state === 'post';
};

function toMatch(event, teamId, competitionName) {
  const comp = event.competitions?.[0];
  if (!comp || !isCompleted(comp)) return null;
  const us = comp.competitors?.find((c) => String(c.id ?? c.team?.id) === teamId);
  const them = comp.competitors?.find((c) => c !== us);
  if (!us || !them) return null;
  const gf = scoreOf(us);
  const ga = scoreOf(them);
  if (gf == null || ga == null) return null;
  // Uitslag na 90/120 minuten; een strafschoppenserie telt als gelijkspel.
  const result = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
  const opp = teamInfo(them.team || {});
  return {
    id: String(event.id),
    date: event.date || comp.date,
    // Staat de competitie bij de wedstrijd zelf, gebruik die; anders de competitie waarin we zochten.
    competition: COMPETITIONS[event.league?.slug] || competitionName,
    home: us.homeAway === 'home',
    opponent: opp.name,
    opponentLogo: opp.logo,
    gf,
    ga,
    result,
  };
}

async function fetchForm(team) {
  const byId = new Map();
  for (const [slug, compName] of Object.entries(COMPETITIONS)) {
    for (const season of [SEASON, SEASON - 1]) {
      const body = await api(`/site/v2/sports/soccer/${slug}/teams/${team.id}/schedule`, { season });
      for (const event of body?.events || []) {
        const m = toMatch(event, team.id, compName);
        if (m && !byId.has(m.id)) byId.set(m.id, m);
      }
    }
  }

  const matches = [...byId.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, FORM_LENGTH)
    .map(({ id, ...m }) => m);

  const points = matches.reduce((s, m) => s + (m.result === 'W' ? 3 : m.result === 'D' ? 1 : 0), 0);
  const goalsFor = matches.reduce((s, m) => s + m.gf, 0);
  const goalsAgainst = matches.reduce((s, m) => s + m.ga, 0);
  console.log(`    ${byId.size} gespeelde duels gevonden, vorm: ${matches.map((m) => m.result).reverse().join('') || '-'}`);
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
  let found = false;
  for (const slug of Object.keys(COMPETITIONS)) {
    const body = await api(`/site/v2/sports/soccer/${slug}/scoreboard`, { dates: date.replaceAll('-', '') });
    for (const event of body?.events || []) {
      const comp = event.competitions?.[0];
      if (!isCompleted(comp)) continue;
      if (comp.competitors?.some((c) => teamIds.has(String(c.id ?? c.team?.id)))) {
        console.log(`  ${date}: ${event.name || event.shortName}`);
        found = true;
      }
    }
  }
  return found;
}

async function main() {
  const existing = await readExisting();
  if (!FORCE && existing?.leagues) {
    const ids = new Set(
      Object.values(existing.leagues).flatMap((groups) => Object.values(groups).flatMap((g) => g.map((t) => String(t.id)))),
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
    source: 'ESPN',
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
