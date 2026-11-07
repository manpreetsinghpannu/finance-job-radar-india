#!/usr/bin/env node
/**
 * boards.mjs: search UK job boards for finance roles, alongside the employer
 * careers-site scan.
 *
 * Boards (all public search pages, no login):
 *   LinkedIn (public job search), Reed, S1Jobs, MyJobScotland, ScotJobsNet.
 * Not included because they block automated access from GitHub's servers:
 *   Indeed UK, Totaljobs, CV-Library, GOV.UK Find a Job; NHS Scotland loads
 *   its results in the browser only.
 *
 * Each run searches every board for the queries in boards.yml, applies the
 * same title / seniority / UK-location / visa filters as portals.yml, skips
 * anything already seen (same link, or same firm + title as a role already
 * listed), and records new roles exactly like the main scan does:
 *   - appended to data/pipeline.md and data/scan-history.tsv
 *   - added to the scan receipt, so alerts, the scan log, CV grouping and
 *     JOBS.md include them automatically.
 *
 * Usage: node scripts/boards.mjs --engine <career-ops dir> --receipt <receipt.json>
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ENGINE = path.resolve(opt('--engine', '../career-ops'));
const RECEIPT = opt('--receipt');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAUSE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers
const decode = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/\\u00a3/g, '£').replace(/\\u0026/g, '&').replace(/\\\//g, '/')
  .replace(/\s+/g, ' ').trim();
const isoDay = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
const titleFromSlug = (slug) => decode(slug.replace(/-\d{5,}$/, '').replace(/-/g, ' ')).replace(/\b\w/g, (c) => c.toUpperCase());

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': process.env.RADAR_LANG || 'en-GB,en;q=0.9', accept: 'text/html,application/json' }, signal: ctrl.signal });
    return { status: res.status, text: res.ok ? await res.text() : '' };
  } catch (e) {
    return { status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------------ parsers
// Each returns [{ url, title, company, location, posted }]

export function parseLinkedIn(html) {
  const out = [];
  for (const card of html.split(/<li[\s>]/).slice(1)) {
    const href = card.match(/href="(https:\/\/[a-z]{2,3}\.linkedin\.com\/jobs\/view\/[^"?]+)/);
    if (!href) continue;
    const title = card.match(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/) || card.match(/<span class="sr-only">([\s\S]*?)<\/span>/);
    const company = card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
    const location = card.match(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/);
    const posted = card.match(/<time[^>]*datetime="([\d-]+)"/);
    out.push({ url: href[1].replace(/^https:\/\/[a-z]{2,3}\./, 'https://www.'), title: decode(title?.[1]), company: decode(company?.[1]), location: decode(location?.[1]), posted: posted?.[1] || '' });
  }
  return out;
}

export function parseReed(html) {
  const out = [];
  for (const card of html.split('data-qa="job-card"').slice(1)) {
    const a = card.match(/<a[^>]+href="(\/jobs\/[a-z0-9-]+\/(\d{6,}))[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = card.match(/data-qa="job-title-btn-wrapper"[^>]*>([\s\S]*?)<\/button>/)?.[1] || a[3];
    const company = card.match(/data-qa="job-posted-by"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)?.[1]
      || card.match(/data-element="recruiter"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '';
    const location = card.match(/data-qa="job-metadata-location"[^>]*>([\s\S]*?)<\/(?:li|span|div)>/)?.[1] || '';
    const posted = card.match(/data-qa="job-posted-by"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
    const day = /\btoday\b|just now|hour/i.test(posted) ? new Date().toISOString().slice(0, 10)
      : /yesterday/i.test(posted) ? new Date(Date.now() - 86400000).toISOString().slice(0, 10) : '';
    out.push({ url: `https://www.reed.co.uk${a[1]}`, title: decode(title), company: decode(company), location: decode(location), posted: day });
  }
  return out;
}

export function parseS1Jobs(html) {
  const out = [];
  const re = /"url":\s*"(\/job\/([a-z0-9-]+-(\d{6,})))"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const start = Math.max(0, m.index - 2500);
    const obj = html.slice(start, m.index + 2500);
    const near = (key) => {
      const all = [...obj.matchAll(new RegExp(`"${key}":\\s*"([^"]*)"`, 'g'))];
      if (!all.length) return '';
      const mid = m.index - start;
      return all.sort((a, b) => Math.abs(a.index - mid) - Math.abs(b.index - mid))[0][1];
    };
    // Titles sit in neighbouring objects too, so only accept one whose
    // slugified form matches this job's URL slug; otherwise rebuild it from the slug.
    const slug = m[2].replace(/-\d{5,}$/, '');
    const slugify = (t) => decode(t).toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const candidates = [...obj.matchAll(/"(?:JobTitle|Title|title)":\s*"([^"]+)"/g)].map((x) => x[1]);
    const title = candidates.find((t) => slugify(t) === slug) || candidates.find((t) => slug.startsWith(slugify(t)) && slugify(t).length > 5) || titleFromSlug(m[2]);
    out.push({
      url: `https://www.s1jobs.com${m[1]}`,
      title: decode(title),
      company: decode(near('CompanyName')),
      location: [decode(near('JobLocationCounty')), 'Scotland'].filter(Boolean).join(', '),
      posted: isoDay(near('PublicationDate').replace(' ', 'T') + 'Z'),
    });
  }
  return out;
}

export function parseMyJobScotland(html) {
  const out = [];
  for (const card of html.split(/class="mjs-card[\s"]/).slice(1)) {
    const a = card.match(/href="(\/apply\?jobId=[^"]+)"[^>]*aria-label="Apply for ([^"]+)"/);
    if (!a) continue;
    const employer = card.match(/mjs-card__(?:employer|organisation|subtitle)[^>]*>([\s\S]*?)<\//)?.[1]
      || card.match(/<h4[^>]*>([\s\S]*?)<\/h4>/)?.[1] || 'Scottish public sector';
    const location = card.match(/mjs-card__location[^>]*>([\s\S]*?)<\//)?.[1] || '';
    const posted = card.match(/data-date="([\d-]+)T/)?.[1] || '';
    out.push({ url: `https://www.myjobscotland.gov.uk${decode(a[1])}`, title: decode(a[2]), company: decode(employer), location: [decode(location), 'Scotland'].filter(Boolean).join(', '), posted });
  }
  return out;
}

export function parseScotJobsNet(html) {
  const out = [];
  for (const art of html.split('<article').slice(1)) {
    if (!/job_listing/.test(art)) continue;
    const a = art.match(/class="entry-title"[^>]*>\s*<a href="(https:\/\/scotjobsnet\.co\.uk\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const loc = art.match(/job_listing_location-([a-z0-9-]+)/)?.[1] || '';
    const date = art.match(/<div class="date">\s*([^<]+?)\s*<\/div>/)?.[1] || '';
    const recruiter = art.match(/<div class="description[^"]*">\s*([A-Z][\w&.' -]{2,60}?) is recruiting/)?.[1] || '';
    out.push({
      url: a[1], title: decode(a[2]), company: decode(recruiter) || 'via ScotJobsNet',
      location: [loc.replace(/^jobs-in-|-jobs$/g, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), 'Scotland'].filter(Boolean).join(', '),
      posted: isoDay(date),
    });
  }
  return out;
}

const BOARDS = {
  linkedin: {
    name: 'LinkedIn',
    url: (q, cfg) => `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(cfg.location || 'United Kingdom')}&f_TPR=r${(cfg.hours || 24) * 3600}&start=0`,
    parse: parseLinkedIn,
  },
  reed: { name: 'Reed', url: (q) => `https://www.reed.co.uk/jobs/${q.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-')}-jobs?dateCreatedOffSet=lastthreedays`, parse: parseReed },
  s1jobs: { name: 'S1Jobs', url: (q) => `https://www.s1jobs.com/jobs/?keywords=${encodeURIComponent(q)}`, parse: parseS1Jobs },
  myjobscotland: { name: 'MyJobScotland', url: (q) => `https://www.myjobscotland.gov.uk/search-jobs?keywords=${encodeURIComponent(q)}`, parse: parseMyJobScotland },
  scotjobsnet: { name: 'ScotJobsNet', url: (q) => `https://scotjobsnet.co.uk/?s=${encodeURIComponent(q)}`, parse: parseScotJobsNet },
};

// ------------------------------------------------------------------- main
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  const { loadYaml } = await import(pathToFileURL(path.join(ENGINE, 'lib/yaml-document.mjs')).href);
  const { buildTitleFilter } = await import(pathToFileURL(path.join(ENGINE, 'title-keywords.mjs')).href);
  const { classifyTier } = await import(pathToFileURL(path.join(ENGINE, 'classify-tier.mjs')).href);
  process.env.CAREER_OPS_ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
  const { buildLocationFilter } = await import(pathToFileURL(path.join(ENGINE, 'scan.mjs')).href);

  const cfg = loadYaml(readFileSync('boards.yml', 'utf8')) || {};
  const portals = loadYaml(readFileSync('portals.yml', 'utf8')) || {};
  const titleOk = buildTitleFilter(portals.title_filter);
  const skip = new Set(portals.skip_tiers || []);
  const locationOk = portals.location_filter ? buildLocationFilter(portals.location_filter) : () => true;
  const maxAge = Number(cfg.max_age_days || 3);
  const cutoff = new Date(Date.now() - maxAge * 86400000).toISOString().slice(0, 10);

  // Already seen: every URL in scan history, plus firm+title of listed roles
  const history = existsSync('data/scan-history.tsv') ? readFileSync('data/scan-history.tsv', 'utf8') : '';
  const seenUrls = new Set(history.split('\n').slice(1).map((l) => l.split('\t')[0]).filter(Boolean));
  const pipelineText = existsSync('data/pipeline.md') ? readFileSync('data/pipeline.md', 'utf8') : '';
  const seenPairs = new Set();
  for (const l of pipelineText.split('\n')) {
    const c = l.split(' | ');
    if (l.startsWith('- [') && c.length >= 3) seenPairs.add(`${norm(c[1])}|${norm(c[2])}`);
  }

  const added = [];
  const summary = {};
  // A board's first run records what is already open without alerting.
  const STATE = 'data/boards-state.json';
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const silent = new Set();
  for (const [id, board] of Object.entries(BOARDS)) {
    const bc = cfg.boards?.[id];
    if (!bc || bc.enabled === false) continue;
    const s = { searches: 0, failed: 0, found: 0, passed: 0, new: 0 };
    summary[board.name] = s;
    if (!state[board.name]) silent.add(board.name);
    for (const q of bc.queries || cfg.queries || []) {
      s.searches++;
      const r = await get(board.url(q, bc));
      if (!r.text) { s.failed++; console.error(`boards: ${board.name} "${q}" → ${r.status || r.error}`); await sleep(PAUSE_MS); continue; }
      let jobs = [];
      try { jobs = board.parse(r.text); } catch (e) { console.error(`boards: ${board.name} parse error ${e.message}`); }
      s.found += jobs.length;
      if (s.searches === 1) console.log(`boards: ${board.name} sample → ${JSON.stringify(jobs.slice(0, 2))}`);
      for (const j of jobs) {
        if (!j.url || !j.title) continue;
        if (!titleOk(j.title) || skip.has(classifyTier(j.title)) || !locationOk(j.location, j.title)) continue;
        if (j.posted && j.posted < cutoff) continue;
        s.passed++;
        const pair = `${norm(j.company)}|${norm(j.title)}`;
        if (seenUrls.has(j.url) || seenPairs.has(pair)) continue;
        seenUrls.add(j.url);
        seenPairs.add(pair);
        added.push({ ...j, board: board.name });
        s.new++;
      }
      await sleep(PAUSE_MS);
    }
  }

  // Record like the main scan does
  if (added.length) {
    const today = new Date().toISOString().slice(0, 10);
    const lines = added.map((j) => `- [ ] ${j.url} | ${j.company || j.board} | ${j.title} | ${j.location || process.env.RADAR_COUNTRY || 'UK'}${j.posted ? ` | posted: ${j.posted}` : ''} | note: via ${j.board}`);
    const marker = '\n## Processed';
    const next = pipelineText.includes(marker)
      ? pipelineText.replace(marker, `${lines.join('\n')}\n${marker}`)
      : `${pipelineText.replace(/\s*$/, '\n')}${lines.join('\n')}\n`;
    writeFileSync('data/pipeline.md', next);
    const cols = (history.split('\n')[0] || 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation').split('\t');
    const rows = added.map((j) => cols.map((c) => ({ url: j.url, first_seen: today, portal: `board:${j.board}`, title: j.title, company: j.company, status: 'added', location: j.location, posted_at: j.posted }[c] ?? '')).map((v) => String(v).replace(/[\t\n]/g, ' ')).join('\t'));
    appendFileSync('data/scan-history.tsv', `${history.endsWith('\n') || !history ? '' : '\n'}${rows.join('\n')}\n`);
  }

  if (RECEIPT && existsSync(RECEIPT)) {
    const raw = readFileSync(RECEIPT, 'utf8').trim().split('\n');
    const idx = raw.map((l, i) => (l.startsWith('{') ? i : -1)).filter((i) => i >= 0).pop();
    if (idx !== undefined) {
      const r = JSON.parse(raw[idx]);
      r.added_urls = [...(r.added_urls || []), ...added.filter((j) => !silent.has(j.board)).map((j) => j.url)];
      r.added = r.added_urls.length;
      r.job_boards = summary;
      raw[idx] = JSON.stringify(r);
      writeFileSync(RECEIPT, `${raw.join('\n')}\n`);
    }
  }
  const today2 = new Date().toISOString().slice(0, 10);
  for (const name of Object.keys(summary)) if (!state[name] && summary[name].searches > summary[name].failed) state[name] = { first_run: today2 };
  writeFileSync(STATE, `${JSON.stringify(state, null, 1)}\n`);
  if (silent.size) console.log(`boards: first run for ${[...silent].join(', ')}: roles recorded without alerts`);
  console.log(`boards: ${added.length} new roles · ${Object.entries(summary).map(([n, s]) => `${n} ${s.new} new/${s.passed} matching/${s.found} seen${s.failed ? `, ${s.failed} failed` : ''}`).join(' · ')}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) main().catch((e) => { console.error(e); process.exit(0); });
