#!/usr/bin/env node
/**
 * check-live.mjs: find roles on JOBS.md whose posting has been taken down, so
 * the jobs page, top picks and alerts stop showing them.
 *
 * Each run re-checks up to MAX_PER_RUN listed roles that haven't been checked in
 * the last RECHECK_HOURS, oldest check first, so every role is re-checked every
 * few hours without slowing the hourly scan down.
 *
 * How a role is checked (no browser, no AI):
 *   - Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Workable, ...:
 *     career-ops' liveness-api.mjs asks the hiring system's own API.
 *   - Oracle Recruiting Cloud (JPMorgan, Next): the public job-details API; an
 *     empty answer for the job id means it has been withdrawn.
 *   - Job boards, by their own "gone" signals (checked 23 Nov 2026):
 *       LinkedIn  guest job page shows "No longer accepting applications"
 *       Reed      HTTP 404 with notFoundReason JOB_EXPIRED
 *       S1Jobs    HTTP 410 Gone
 *       ScotJobsNet / MyJobScotland  HTTP 404/410 only
 *     LinkedIn rate-limits hard, so it is checked slowly (a few per hourly run).
 *   - Adzuna blocks automated page loads (403) and anything else unknown:
 *     not checked, never removed.
 *
 * `--all` checks every listed role once regardless of when it was last
 * checked (the "Full job-list check" workflow).
 *
 * Conservative: a role is only marked closed on a definite "gone" answer
 * (404/410, a withdrawn marker, or an empty Oracle lookup). Timeouts, blocks
 * and odd answers leave it listed.
 *
 * Writes data/liveness.json: { url: { status, checked_at, closed_at?, reason } }
 *
 * Usage: node scripts/check-live.mjs --engine <career-ops dir> [--max 80]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i !== -1 && args[i + 1] ? args[i + 1] : d; };
const ENGINE = path.resolve(opt('--engine', '../career-ops'));
const MAX_PER_RUN = Number(opt('--max', 80));
const RECHECK_HOURS = 3;
const STORE = 'data/liveness.json';
const UA = 'Mozilla/5.0 (compatible; finance-job-radar; +https://github.com/career-ops-hq/career-ops)';

/** Oracle Recruiting Cloud posting → its job-details API. */
export function oracleTarget(url) {
  const m = String(url).match(/^https:\/\/([a-z0-9.-]+\.oraclecloud\.com)\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[A-Za-z]{2})?\/sites\/([A-Za-z0-9_]+)\/job\/(\d+)/);
  if (!m) return null;
  const [, host, site, id] = m;
  return `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${site}`;
}

/** Read an Oracle job-details answer: an empty item list means the job is gone. */
export function classifyOracle(status, json) {
  if (status !== 200 || !json || !Array.isArray(json.items)) return null;
  if (json.items.length === 0) return { result: 'expired', reason: 'Oracle: job id no longer listed' };
  return { result: 'active', reason: 'Oracle: job listed' };
}

async function checkOracle(url) {
  const api = oracleTarget(url);
  if (!api) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(api, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'error', signal: ctrl.signal });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return classifyOracle(res.status, json);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Job-board page → what to fetch and how to read it. */
export function boardTarget(url) {
  const u = String(url);
  let m = u.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/);
  if (m) return { kind: 'linkedin', fetchUrl: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${m[1]}`, pause: 7000 };
  if (/^https:\/\/www\.reed\.co\.uk\/jobs\/[^/]+\/\d+/.test(u)) return { kind: 'reed', fetchUrl: u, pause: 1500 };
  if (/^https:\/\/www\.s1jobs\.com\/job\//.test(u)) return { kind: 's1jobs', fetchUrl: u, pause: 1500 };
  if (/^https:\/\/(www\.)?scotjobsnet\.co\.uk\/job\//.test(u)) return { kind: 'scotjobsnet', fetchUrl: u, pause: 1500 };
  if (/myjobscotland\.gov\.uk\//.test(u)) return { kind: 'myjobscotland', fetchUrl: u, pause: 1500 };
  return null;
}

/** Read a job-board answer. Only definite signals close a role. */
export function classifyBoard(kind, status, text) {
  if (status === 429 || status === 403 || status === 0) return null; // throttled / blocked / network
  if (kind === 'linkedin') {
    if (status === 404 || status === 410) return { result: 'expired', reason: `LinkedIn: HTTP ${status}` };
    if (status === 200 && /No longer accepting applications/i.test(text)) return { result: 'expired', reason: 'LinkedIn: no longer accepting applications' };
    if (status === 200 && /top-card-layout__title|show-more-less-html/.test(text)) return { result: 'active', reason: 'LinkedIn: open' };
    return null;
  }
  if (kind === 'reed') {
    if (status === 404 && /JOB_EXPIRED|This job has expired/.test(text)) return { result: 'expired', reason: 'Reed: job expired' };
    if (status === 200 && /Apply now/i.test(text)) return { result: 'active', reason: 'Reed: open' };
    return null;
  }
  if (status === 404 || status === 410) return { result: 'expired', reason: `${kind}: HTTP ${status}` };
  if (status === 200) return { result: 'active', reason: `${kind}: page loads` };
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function checkBoard(t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(t.fetchUrl, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'accept-language': 'en-IN,en;q=0.9' }, signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, v: classifyBoard(t.kind, res.status, text) };
  } catch {
    return { status: 0, v: null };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { checkLivenessViaApi, resolveAtsApi } = await import(pathToFileURL(path.join(ENGINE, 'liveness-api.mjs')).href);
  const store = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : {};
  const listed = existsSync('data/top-picks.json') ? Object.keys(JSON.parse(readFileSync('data/top-picks.json', 'utf8')).assign || {}) : [];

  const ALL = args.includes('--all');
  const now = Date.now();
  const byAge = (a, b) => (store[a]?.checked_at || '').localeCompare(store[b]?.checked_at || '');
  const open = listed
    .filter((u) => store[u]?.status !== 'closed')
    .filter((u) => ALL || !store[u]?.checked_at || now - Date.parse(store[u].checked_at) > RECHECK_HOURS * 3600000)
    .sort(byAge);
  const apiDue = open.filter((u) => resolveAtsApi(u) || oracleTarget(u)).slice(0, ALL ? Infinity : MAX_PER_RUN);
  // Job boards: LinkedIn slowly (it rate-limits), the others up to MAX_PER_RUN.
  const LINKEDIN_PER_RUN = Number(opt('--linkedin', 12));
  const boardDue = [];
  const per = {};
  for (const u of open) {
    const t = boardTarget(u);
    if (!t) continue;
    const cap = ALL ? Infinity : t.kind === 'linkedin' ? LINKEDIN_PER_RUN : 40;
    if ((per[t.kind] = (per[t.kind] || 0) + 1) <= cap) boardDue.push(u);
  }
  const due = [...apiDue, ...boardDue];

  const boardCache = new Map();
  const verdicts = [];
  for (const url of apiDue) {
    let v = null;
    try {
      v = oracleTarget(url) ? await checkOracle(url) : await checkLivenessViaApi(url, { boardCache });
    } catch { v = null; }
    const vendor = oracleTarget(url) ? 'oracle' : (resolveAtsApi(url)?.ats || 'other');
    verdicts.push({ url, vendor, v, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
  }
  let throttled = 0;
  for (const url of boardDue) {
    const t = boardTarget(url);
    if (t.kind === 'linkedin' && throttled >= 3) { verdicts.push({ url, vendor: t.kind, v: null, skip: true }); continue; }
    let r = await checkBoard(t);
    if (r.status === 429) { await sleep(60000); r = await checkBoard(t); }
    if (t.kind === 'linkedin') throttled = r.status === 429 ? throttled + 1 : 0;
    if (throttled === 3) console.log('check-live: LinkedIn keeps rate-limiting; stopping LinkedIn checks for this run');
    verdicts.push({ url, vendor: t.kind, v: r.v, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
    await sleep(t.pause);
  }

  // Safety valve: if every role checked on one hiring system (3 or more) came
  // back "closed" in the same run, that is far more likely an API change or a
  // block than a firm-wide purge, so none of them are removed this time.
  const byVendor = new Map();
  for (const x of verdicts) {
    const c = byVendor.get(x.vendor) || { n: 0, expired: 0 };
    c.n++; if (x.v?.result === 'expired') c.expired++;
    byVendor.set(x.vendor, c);
  }
  // (LinkedIn, Reed and S1Jobs give explicit "expired" answers, so they are exempt.)
  const explicit = new Set(['linkedin', 'reed', 's1jobs']);
  const suspicious = new Set([...byVendor].filter(([k, c]) => !explicit.has(k) && c.n >= 3 && c.expired === c.n).map(([k]) => k));
  for (const k of suspicious) console.log(`check-live: every ${k} role came back closed; ignoring this run's ${k} results`);

  let closed = 0;
  let unsure = 0;
  for (const { url, vendor, v, at, skip } of verdicts) {
    if (skip) continue;
    if (v?.result === 'expired' && !suspicious.has(vendor)) {
      store[url] = { status: 'closed', checked_at: at, closed_at: at, reason: v.reason || v.code };
      closed++;
      console.log(`closed: ${url} (${v.reason || v.code})`);
    } else if (v?.result === 'active') {
      store[url] = { status: 'live', checked_at: at };
    } else {
      store[url] = { ...(store[url] || {}), status: store[url]?.status === 'live' ? 'live' : 'unknown', checked_at: at };
      unsure++;
    }
  }
  writeFileSync(STORE, `${JSON.stringify(store, null, 1)}\n`);
  const kinds = {};
  for (const x of verdicts) if (!x.skip) { const k = (kinds[x.vendor] ||= { checked: 0, closed: 0 }); k.checked++; if (x.v?.result === 'expired' && !suspicious.has(x.vendor)) k.closed++; }
  console.log(`check-live: checked ${due.length}, closed ${closed}, inconclusive ${unsure}, listed ${listed.length} · ${Object.entries(kinds).map(([k, c]) => `${k} ${c.closed}/${c.checked}`).join(' · ')}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) main().catch((e) => { console.error(e); process.exit(0); });
