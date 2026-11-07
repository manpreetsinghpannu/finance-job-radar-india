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
 *   - Anything else (Eightfold, custom sites): not checked, never removed.
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

async function main() {
  const { checkLivenessViaApi, resolveAtsApi } = await import(pathToFileURL(path.join(ENGINE, 'liveness-api.mjs')).href);
  const store = existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : {};
  const listed = existsSync('data/top-picks.json') ? Object.keys(JSON.parse(readFileSync('data/top-picks.json', 'utf8')).assign || {}) : [];

  const now = Date.now();
  const due = listed
    .filter((u) => store[u]?.status !== 'closed')
    .filter((u) => resolveAtsApi(u) || oracleTarget(u))
    .filter((u) => !store[u]?.checked_at || now - Date.parse(store[u].checked_at) > RECHECK_HOURS * 3600000)
    .sort((a, b) => (store[a]?.checked_at || '').localeCompare(store[b]?.checked_at || ''))
    .slice(0, MAX_PER_RUN);

  const boardCache = new Map();
  const verdicts = [];
  for (const url of due) {
    let v = null;
    try {
      v = oracleTarget(url) ? await checkOracle(url) : await checkLivenessViaApi(url, { boardCache });
    } catch { v = null; }
    const vendor = oracleTarget(url) ? 'oracle' : (resolveAtsApi(url)?.ats || 'other');
    verdicts.push({ url, vendor, v, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });
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
  const suspicious = new Set([...byVendor].filter(([, c]) => c.n >= 3 && c.expired === c.n).map(([k]) => k));
  for (const k of suspicious) console.log(`check-live: every ${k} role came back closed; ignoring this run's ${k} results`);

  let closed = 0;
  let unsure = 0;
  for (const { url, vendor, v, at } of verdicts) {
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
  console.log(`check-live: checked ${due.length}, closed ${closed}, inconclusive ${unsure}, listed ${listed.length}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) main().catch((e) => { console.error(e); process.exit(0); });
