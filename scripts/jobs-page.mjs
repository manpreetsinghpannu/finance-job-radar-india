#!/usr/bin/env node
/**
 * jobs-page.mjs: build JOBS.md (and data/top-picks.json) from what the scans found.
 *
 * Page layout, top to bottom:
 *   1. Latest scan: when it ran and the new roles it found, grouped by CV
 *   2. Top picks: best 2 open roles for each CV
 *   3. Scan log: every scan in the last 7 days and what it found, grouped by CV
 *   4. All open roles, grouped by CV
 *
 * Every role is put under ONE heading everywhere: the CV it fits best
 * (profiles.yml), or "Other" if it passed the filters but fits no CV.
 *
 * Usage: node scripts/jobs-page.mjs --engine <career-ops dir> [--out JOBS.md]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePipelineLine } from './notify.mjs';
import { compileProfiles, rankAll, scoreRole, baseFirm } from './rank.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ENGINE = path.resolve(opt('--engine', '../career-ops'));
const OUT = opt('--out', 'JOBS.md');
const PIPELINE = opt('--pipeline', 'data/pipeline.md');
const HISTORY = opt('--history', 'data/scan-history.tsv');
const PICKS = opt('--picks', 'data/top-picks.json');
const LOG = opt('--log', 'data/scan-log.jsonl');
const FRESH_DAYS = 21; // top picks only from roles posted (or first seen) in the last 3 weeks
const LOG_DAYS = 7;

const OTHER = { id: 'other', cv: 'Other (fits no CV closely, may still be worth a look)' };
const KIND_LABEL = {
  hourly: 'hourly scan',
  manual: 'run by hand',
  starting: 'starting scan: roles already open when the radar started (no alerts sent)',
  'new-firms': 'new firms added: roles already open at firms added this day (no alerts sent)',
};

const cell = (s) => String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const ukTime = (iso, withDay = true) => new Date(iso).toLocaleString('en-GB', {
  timeZone: 'Europe/London', ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit',
});
const ukDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long' });
const anchor = (t) => t.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
const shortCv = (p) => (p.id === 'other' ? 'Other' : String(p.cv).replace(/\s*\(.*$/, '').replace(/ CV$/, ''));

/** First-seen date per URL from scan-history.tsv. */
function firstSeen() {
  const map = new Map();
  if (!existsSync(HISTORY)) return map;
  const [header, ...rows] = readFileSync(HISTORY, 'utf8').split('\n');
  const cols = header.split('\t');
  const iu = cols.indexOf('url');
  const id = cols.indexOf('first_seen');
  for (const r of rows) {
    const c = r.split('\t');
    if (c[iu] && c[id] && !map.has(c[iu])) map.set(c[iu], c[id].slice(0, 10));
  }
  return map;
}

function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

async function main() {
  const { buildTitleFilter } = await import(pathToFileURL(path.join(ENGINE, 'title-keywords.mjs')).href);
  const { classifyTier } = await import(pathToFileURL(path.join(ENGINE, 'classify-tier.mjs')).href);
  const { loadYaml } = await import(pathToFileURL(path.join(ENGINE, 'lib/yaml-document.mjs')).href);
  process.env.CAREER_OPS_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
  const { buildLocationFilter } = await import(pathToFileURL(path.join(ENGINE, 'scan.mjs')).href);

  const cfg = loadYaml(readFileSync('portals.yml', 'utf8')) || {};
  const titleOk = buildTitleFilter(cfg.title_filter);
  const skip = new Set(cfg.skip_tiers || []);
  const locationOk = cfg.location_filter ? buildLocationFilter(cfg.location_filter) : () => true;
  const compiled = compileProfiles(existsSync('profiles.yml') ? loadYaml(readFileSync('profiles.yml', 'utf8')) : {});
  const profiles = [...compiled.profiles, OTHER];

  const sponsors = new Map();
  if (existsSync('data/sponsors.json')) {
    for (const [f, v] of Object.entries(JSON.parse(readFileSync('data/sponsors.json', 'utf8')).firms || {})) sponsors.set(f, v.licensed);
  }
  const now = new Date();
  const ctx = { ...compiled, sponsors, now: now.getTime() };

  // ---- postings found to be taken down (scripts/check-live.mjs)
  const live = existsSync('data/liveness.json') ? JSON.parse(readFileSync('data/liveness.json', 'utf8')) : {};
  const removed = [];

  // ---- every matched role that still passes today's filters, filed under its best CV
  const seen = firstSeen();
  const byUrl = new Map();
  for (const line of (existsSync(PIPELINE) ? readFileSync(PIPELINE, 'utf8') : '').split('\n')) {
    const r = parsePipelineLine(line.trim());
    if (!r || byUrl.has(r.url)) continue;
    if (!titleOk(r.title) || skip.has(classifyTier(r.title)) || !locationOk(r.location, r.title)) continue;
    if (live[r.url]?.status === 'closed') { removed.push({ ...r, closedAt: live[r.url].closed_at }); continue; }
    const role = { ...r, date: r.posted || '', seenAt: seen.get(r.url) || '' };
    let best = null;
    for (const p of compiled.profiles) {
      const sc = scoreRole({ ...role, posted: role.date }, p, ctx);
      if (sc && (!best || sc.score > best.score)) best = { profile: p, score: sc.score };
    }
    role.profile = best ? best.profile : OTHER;
    role.score = best ? best.score : 0;
    byUrl.set(r.url, role);
  }
  const rows = [...byUrl.values()];

  const tag = (r) => (/startup\/SME/.test(r.note || '') ? ' · startup/SME' : '');
  const sponsorMark = (r) => (sponsors.get(baseFirm(r.company)) === true ? '✅' : '❔');
  const table = (list) => [
    '| Posted | Role | Firm | Location |',
    '|---|---|---|---|',
    ...list.map((r) => `| ${r.date || '—'} | [${cell(r.title)}](${r.url}) | ${cell(baseFirm(r.company))}${tag(r)} | ${cell(r.location).slice(0, 50)} |`),
  ].join('\n');
  const groupByCv = (list) => profiles
    .map((p) => [p, list.filter((r) => r.profile.id === p.id).sort((a, b) => b.score - a.score)])
    .filter(([, l]) => l.length);
  const countLine = (list) => groupByCv(list).map(([p, l]) => `${shortCv(p)} ${l.length}`).join(' · ');
  const grouped = (list, level = '###') => groupByCv(list).flatMap(([p, l]) => [`${level} ${p.cv}: ${l.length}`, '', table(l), '']);

  // ---- scans and the roles each one found
  const cutoff = now.getTime() - LOG_DAYS * 86400000;
  const scans = readLog().filter((e) => Date.parse(e.at) >= cutoff).reverse().map((e) => ({
    ...e,
    roles: (e.new_urls || []).map((u) => byUrl.get(u)).filter(Boolean),
    dropped: (e.new_urls || []).filter((u) => !byUrl.has(u)).length,
  }));
  const latest = scans[0];

  // ---- top picks per CV
  const freshCut = new Date(now - FRESH_DAYS * 86400000).toISOString().slice(0, 10);
  // Picks (and the morning digest built from them) only come from firms on the
  // Home Office sponsor register; other roles stay listed below.
  const fresh = rows.filter((r) => (r.date ? r.date >= freshCut : (r.seenAt || '') >= freshCut))
    .filter((r) => sponsors.size === 0 || sponsors.get(baseFirm(r.company)) === true);
  const ranked = rankAll(fresh.map((r) => ({ ...r, posted: r.date })), compiled, { sponsors, now: now.getTime() });
  const picksOut = [...ranked.values()].map(({ profile, picks, total }) => ({
    id: profile.id, cv: profile.cv, matching: total,
    picks: picks.map((p) => ({ title: p.title, company: baseFirm(p.company), location: p.location, posted: p.date || null, url: p.url, score: p.score, why: p.why, sponsor: p.sponsor ?? null })),
  }));
  const assign = Object.fromEntries(rows.map((r) => [r.url, { id: r.profile.id, cv: r.profile.cv, score: r.score }]));
  writeFileSync(PICKS, `${JSON.stringify({ generated_at: now.toISOString(), order: profiles.map((p) => p.id), names: Object.fromEntries(profiles.map((p) => [p.id, shortCv(p)])), profiles: picksOut, assign }, null, 1)}\n`);

  // ---- page
  const L = [];
  L.push('# Finance jobs found in India', '');
  L.push(`Updated **${ukTime(now.toISOString())}** (UK time) · **${rows.length} open roles** at ${new Set(rows.map((r) => baseFirm(r.company))).size} firms · the radar checks every board about once an hour.`, '');
  L.push('Postings that are taken down are removed automatically: every listed role is re-checked about every 3 hours (JPMorgan, Next and other Oracle sites included; a few custom sites like Morgan Stanley\'s can\'t be checked).', '');
  L.push("Each role is filed under the **one CV it fits best**, or under **Other**. Roles in India only.", '');
  L.push(`**Jump to:** [Latest scan](#latest-scan) · [Top picks for each CV](#top-picks-for-each-cv) · [Scan log](#scan-log-last-${LOG_DAYS}-days) · [All open roles by CV](#all-open-roles-by-cv)`, '');

  L.push('## Latest scan', '');
  if (!latest) {
    L.push('_No scans recorded yet._', '');
  } else {
    L.push(`**${ukTime(latest.at)}** · ${KIND_LABEL[latest.kind] || latest.kind}${latest.boards ? ` · checked ${latest.boards} boards` : ''} · **${latest.roles.length} new role${latest.roles.length === 1 ? '' : 's'}**`, '');
    if (latest.roles.length) {
      L.push(...grouped(latest.roles));
    } else {
      const last = scans.find((s) => s.roles.length && s.kind !== 'starting');
      L.push(`Nothing new this time.${last ? ` The last scan that found something was **${ukTime(last.at)}** (${last.roles.length}: ${countLine(last.roles)}); open it in the scan log below.` : ''}`, '');
    }
  }

  L.push('## Top picks for each CV', '');
  L.push(`Best two open roles for each CV from the last ${FRESH_DAYS} days, ranked on title fit, junior level, how recent and Mumbai. One pick per firm, so a role can be a pick for two CVs.`, '');
  for (const p of picksOut) {
    L.push(`**${p.cv}**${p.matching ? ` (${p.matching} matching)` : ''}`, '');
    if (!p.picks.length) L.push('_No fresh match right now._');
    p.picks.forEach((x, i) => L.push(`${i + 1}. [${cell(x.title)}](${x.url}) · ${cell(x.company)} · ${cell(x.location).slice(0, 40) || 'India'}${x.posted ? ` · posted ${x.posted}` : ''}`));
    L.push('');
  }

  L.push(`## Scan log (last ${LOG_DAYS} days)`, '');
  L.push('Newest first. Tap a scan to see what it found. Scans that found nothing are listed on one line per day.', '');
  let day = '';
  let quiet = [];
  const flushQuiet = () => { if (quiet.length) { L.push(`<sub>Nothing new at: ${quiet.join(', ')}</sub>`, ''); quiet = []; } };
  for (const s of scans) {
    const d = ukDay(s.at);
    if (d !== day) { flushQuiet(); day = d; L.push(`### ${d}`, ''); }
    if (!s.roles.length) { quiet.push(ukTime(s.at, false)); continue; }
    flushQuiet();
    L.push('<details>');
    L.push(`<summary><b>${ukTime(s.at, false)}</b> · ${KIND_LABEL[s.kind] || s.kind} · <b>${s.roles.length} new</b> → ${countLine(s.roles)}</summary>`, '');
    L.push(...grouped(s.roles, '####'));
    if (s.dropped) L.push(`<sub>${s.dropped} more found by this scan are no longer listed (posting closed, or filtered out by a later filter change).</sub>`, '');
    L.push('</details>', '');
  }
  flushQuiet();

  L.push('## All open roles by CV', '');
  const all = groupByCv(rows);
  L.push(`Everything matched so far, newest first within each CV: ${all.map(([p, l]) => `[${shortCv(p)} (${l.length})](#${anchor(`${p.cv}: ${l.length}`)})`).join(' · ')}`, '');
  for (const [p, l] of all) {
    l.sort((a, b) => (b.date || b.seenAt || '').localeCompare(a.date || a.seenAt || '') || b.score - a.score);
    L.push(`### ${p.cv}: ${l.length}`, '', table(l), '');
  }

  const weekAgo = new Date(now - LOG_DAYS * 86400000).toISOString();
  const recentRemoved = removed.filter((r) => (r.closedAt || '') >= weekAgo).sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  L.push(`## Removed: posting closed (last ${LOG_DAYS} days)`, '');
  if (!recentRemoved.length) L.push('_None yet._', '');
  else {
    L.push('<details>', `<summary>${recentRemoved.length} role${recentRemoved.length === 1 ? '' : 's'} taken off the list because the firm closed the posting</summary>`, '');
    L.push('| Closed (UK time) | Role | Firm |', '|---|---|---|');
    for (const r of recentRemoved) L.push(`| ${ukTime(r.closedAt)} | ${cell(r.title)} | ${cell(baseFirm(r.company))} |`);
    L.push('', '</details>', '');
  }

  writeFileSync(OUT, L.join('\n'), 'utf8');
  console.log(`jobs-page: ${rows.length} roles; latest scan ${latest ? `${latest.at} found ${latest.roles.length}` : 'none'}`);
}

main().catch((e) => { console.error(e); process.exit(0); });
