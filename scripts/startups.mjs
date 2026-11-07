#!/usr/bin/env node
/**
 * startups.mjs: hourly scan of Indian startups and scale-ups listed in companies_startups.yaml,
 * through each hiring system's public job-board API.
 *
 * Every job is normalised to { company, title, location, url, posted_date, source }
 * and goes through the same title / seniority / India-location / visa filters as
 * portals.yml (so the rules stay in one place). New roles are recorded the same
 * way as the main scan (data/pipeline.md + data/scan-history.tsv + the scan
 * receipt), tagged "startup/SME", so scoring, the jobs page and alerts pick
 * them up. One failing company never stops the run.
 *
 * Usage:
 *   node scripts/startups.mjs --engine <career-ops dir> --receipt <receipt.json>
 *   node scripts/startups.mjs --engine <career-ops dir> --check     (report only, records nothing)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ENGINE = path.resolve(opt('--engine', '../career-ops'));
const RECEIPT = opt('--receipt');
const CHECK = args.includes('--check');
const LIST = opt('--list', 'companies_startups.yaml');
const STATE = 'data/startups-state.json';
const TAG = 'startup/SME';
const MAX_AGE_DAYS = 30;
const CONCURRENCY = 4;
const TIMEOUT_MS = 20000;
const UA = 'finance-job-radar (+https://github.com/career-ops-hq/career-ops)';

// --------------------------------------------------------------- fetchers
// Each returns a list in the common schema: { company, title, location, url, posted_date, source }

const iso = (v) => {
  if (v === undefined || v === null || v === '') return '';
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
};
const join = (...xs) => [...new Set(xs.flat().filter(Boolean).map((x) => String(x).trim()).filter(Boolean))].join(' · ');

export const FETCHERS = {
  greenhouse: {
    url: (c) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.slug)}/jobs`,
    parse: (json, c) => (json?.jobs || []).map((j) => ({
      company: c.name,
      title: j.title,
      location: join(j.location?.name, (j.offices || []).map((o) => o.location || o.name)),
      url: j.absolute_url,
      posted_date: iso(j.first_published || j.updated_at),
      source: 'greenhouse',
    })),
  },
  lever: {
    url: (c) => `https://api.${c.region === 'eu' ? 'eu.' : ''}lever.co/v0/postings/${encodeURIComponent(c.slug)}?mode=json`,
    parse: (json, c) => (Array.isArray(json) ? json : []).map((j) => ({
      company: c.name,
      title: j.text,
      location: join(j.categories?.location, j.categories?.allLocations || [], j.country, j.workplaceType === 'remote' ? 'Remote' : ''),
      url: j.hostedUrl,
      posted_date: iso(j.createdAt),
      source: 'lever',
    })),
  },
  ashby: {
    url: (c) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.slug)}`,
    parse: (json, c) => (json?.jobs || []).filter((j) => j.isListed !== false).map((j) => ({
      company: c.name,
      title: j.title,
      location: join(j.location, (j.secondaryLocations || []).map((s) => s.location), j.address?.postalAddress?.addressCountry, j.isRemote ? 'Remote' : ''),
      url: j.jobUrl,
      posted_date: iso(j.publishedAt),
      source: 'ashby',
    })),
  },
  workable: {
    url: (c) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(c.slug)}`,
    parse: (json, c) => (json?.jobs || []).map((j) => ({
      company: c.name,
      title: j.title,
      location: join([j.city, j.country].filter(Boolean).join(', '), (j.locations || []).map((l) => [l.city, l.country].filter(Boolean).join(', ')), j.telecommuting ? 'Remote' : ''),
      url: j.url || j.shortlink || `https://apply.workable.com/${c.slug}/j/${j.shortcode}/`,
      posted_date: iso(j.published_on || j.created_at),
      source: 'workable',
    })),
  },
};

async function fetchCompany(c) {
  const f = FETCHERS[c.ats];
  if (!f) return { ok: false, status: 'unknown ats', jobs: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(f.url(c), { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: `HTTP ${res.status}`, jobs: [] };
    const json = await res.json();
    // Workable answers 200 with an empty body for accounts that don't exist.
    if (c.ats === 'workable' && !json?.name && !(json?.jobs || []).length) return { ok: false, status: 'not found', jobs: [] };
    return { ok: true, status: 'ok', jobs: f.parse(json, c).filter((j) => j.title && j.url) };
  } catch (e) {
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : String(e.message).slice(0, 80), jobs: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ------------------------------------------------------------------- main
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const UK_COUNTRY = /\b(india|ind)\b/i; // India radar

async function main() {
  const { loadYaml } = await import(pathToFileURL(path.join(ENGINE, 'lib/yaml-document.mjs')).href);
  const { buildTitleFilter } = await import(pathToFileURL(path.join(ENGINE, 'title-keywords.mjs')).href);
  const { classifyTier } = await import(pathToFileURL(path.join(ENGINE, 'classify-tier.mjs')).href);
  process.env.CAREER_OPS_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
  const { buildLocationFilter } = await import(pathToFileURL(path.join(ENGINE, 'scan.mjs')).href);

  const portals = loadYaml(readFileSync('portals.yml', 'utf8')) || {};
  const titleOk = buildTitleFilter(portals.title_filter);
  const skip = new Set(portals.skip_tiers || []);
  const locationOk = portals.location_filter ? buildLocationFilter(portals.location_filter) : () => true;
  const ukOk = (j) => locationOk(j.location, j.title) && (UK_COUNTRY.test(j.location) || locationOk(j.location.split(' · ')[0], j.title));

  // Skip firms the main scan already tracks (same board slug), so nothing is alerted twice.
  const trackedSlugs = new Set((portals.tracked_companies || []).filter((e) => e.enabled !== false)
    .map((e) => (String(e.careers_url || '').match(/(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com)\/([^/?#]+)/) || [])[1])
    .filter(Boolean).map((s) => s.toLowerCase()));
  const list = (loadYaml(readFileSync(LIST, 'utf8'))?.companies || []).filter((c) => c && c.name && c.ats && c.slug && c.enabled !== false);
  const companies = list.filter((c) => !trackedSlugs.has(String(c.slug).toLowerCase()));

  const results = await pool(companies, CONCURRENCY, async (c) => ({ c, ...(await fetchCompany(c)) }));

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
  const matched = [];
  const report = [];
  for (const r of results) {
    const uk = r.jobs.filter(ukOk);
    const hits = uk.filter((j) => titleOk(j.title) && !skip.has(classifyTier(j.title)) && (!j.posted_date || j.posted_date >= cutoff));
    report.push({ name: r.c.name, ats: r.c.ats, slug: r.c.slug, status: r.status, jobs: r.jobs.length, uk: uk.length, matching: hits.length, sample: hits.slice(0, 2).map((j) => j.title) });
    matched.push(...hits);
  }

  if (CHECK) {
    const lines = ['# Startup list check', '', `Checked ${companies.length} companies (${list.length - companies.length} skipped: already scanned via portals.yml).`, '',
      '| Company | ATS / slug | Status | All jobs | India jobs | Junior finance matches |', '|---|---|---|---|---|---|',
      ...report.map((x) => `| ${x.name} | ${x.ats} / ${x.slug} | ${x.status} | ${x.jobs} | ${x.uk} | ${x.matching}${x.sample.length ? ` (${x.sample.join('; ')})` : ''} |`)];
    mkdirSync('reports', { recursive: true });
    writeFileSync('reports/startups-check.md', `${lines.join('\n')}\n`);
    console.log(lines.join('\n'));
    return;
  }

  // ---- dedupe against everything already seen
  const history = existsSync('data/scan-history.tsv') ? readFileSync('data/scan-history.tsv', 'utf8') : '';
  const seenUrls = new Set(history.split('\n').slice(1).map((l) => l.split('\t')[0]).filter(Boolean));
  const pipelineText = existsSync('data/pipeline.md') ? readFileSync('data/pipeline.md', 'utf8') : '';
  const seenPairs = new Set(pipelineText.split('\n').filter((l) => l.startsWith('- [')).map((l) => l.split(' | ')).filter((c) => c.length >= 3).map((c) => `${norm(c[1])}|${norm(c[2])}`));
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const added = [];
  for (const j of matched) {
    const pair = `${norm(j.company)}|${norm(j.title)}`;
    if (seenUrls.has(j.url) || seenPairs.has(pair)) continue;
    seenUrls.add(j.url); seenPairs.add(pair);
    added.push(j);
  }

  // A company's first successful scan is silent: its open roles are recorded, not alerted.
  const today = new Date().toISOString().slice(0, 10);
  const firstRun = new Set(results.filter((r) => r.ok && !state[r.c.name]).map((r) => r.c.name));
  for (const r of results) if (r.ok && !state[r.c.name]) state[r.c.name] = { first_run: today };
  writeFileSync(STATE, `${JSON.stringify(state, null, 1)}\n`);

  if (added.length) {
    const lines = added.map((j) => `- [ ] ${j.url} | ${j.company} | ${j.title} | ${j.location || 'India'}${j.posted_date ? ` | posted: ${j.posted_date}` : ''} | note: via ${TAG} (${j.source})`);
    const marker = '\n## Processed';
    writeFileSync('data/pipeline.md', pipelineText.includes(marker)
      ? pipelineText.replace(marker, `${lines.join('\n')}\n${marker}`)
      : `${pipelineText.replace(/\s*$/, '\n')}${lines.join('\n')}\n`);
    const cols = (history.split('\n')[0] || 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation').split('\t');
    const rows = added.map((j) => cols.map((c) => ({ url: j.url, first_seen: today, portal: `startup:${j.source}`, title: j.title, company: j.company, status: 'added', location: j.location, posted_at: j.posted_date }[c] ?? '')).map((v) => String(v).replace(/[\t\n]/g, ' ')).join('\t'));
    appendFileSync('data/scan-history.tsv', `${history.endsWith('\n') || !history ? '' : '\n'}${rows.join('\n')}\n`);
  }

  if (RECEIPT && existsSync(RECEIPT)) {
    const raw = readFileSync(RECEIPT, 'utf8').trim().split('\n');
    const idx = raw.map((l, i) => (l.startsWith('{') ? i : -1)).filter((i) => i >= 0).pop();
    if (idx !== undefined) {
      const r = JSON.parse(raw[idx]);
      r.added_urls = [...(r.added_urls || []), ...added.filter((j) => !firstRun.has(j.company)).map((j) => j.url)];
      r.added = r.added_urls.length;
      r.startups = { companies: companies.length, failed: report.filter((x) => x.status !== 'ok').length, new: added.length };
      raw[idx] = JSON.stringify(r);
      writeFileSync(RECEIPT, `${raw.join('\n')}\n`);
    }
  }
  const failed = report.filter((x) => x.status !== 'ok');
  if (failed.length) console.error(`startups: ${failed.length} companies failed: ${failed.map((x) => `${x.name} (${x.status})`).join(', ')}`);
  if (firstRun.size) console.log(`startups: first scan for ${firstRun.size} companies, their open roles recorded without alerts`);
  console.log(`startups: ${companies.length} companies, ${matched.length} matching India roles, ${added.length} new`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) main().catch((e) => { console.error(`startups: ${e.message}`); process.exit(0); });
