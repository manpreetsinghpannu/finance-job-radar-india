#!/usr/bin/env node
/**
 * notify.mjs: send the roles a career-ops scan just found to Slack
 * (and, optionally, to your phone via ntfy.sh).
 *
 * Usage: node scripts/notify.mjs <scan receipt JSON> [pipeline.md]
 *
 * Environment:
 *   SLACK_WEBHOOK_URL  Slack incoming-webhook URL (optional)
 *   NTFY_TOPIC         ntfy.sh topic name for phone push alerts (optional)
 *   SEED_RUN=1         first run: record everything silently, send one summary
 *   SUPPRESS_FILE      file of company names (one per line) not to alert on
 *
 * The scan receipt (scan.mjs --json) lists the URLs added this run; the
 * matching lines in data/pipeline.md carry company, title, location and the
 * posted date, which is what the alert shows.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [receiptPath, pipelinePath = 'data/pipeline.md'] = process.argv.slice(2);
const SLACK = process.env.SLACK_WEBHOOK_URL?.trim();
const NTFY = process.env.NTFY_TOPIC?.trim();
const SEED = process.env.SEED_RUN === '1';
const SUPPRESS_FILE = process.env.SUPPRESS_FILE?.trim();
const PICKS_FILE = process.env.PICKS_FILE?.trim() || 'data/top-picks.json';
const DIGEST_FILE = 'data/digest-sent.txt';
const DIGEST_HOUR = 8; // UK time: first scan at or after 08:00 sends the morning digest
const JOBS_URL = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}/blob/main/JOBS.md#latest-scan` : undefined;
const shortCv = (cv) => String(cv || '').replace(/\s*\(.*$/, '').replace(/ CV$/, '');
const MAX_PER_MESSAGE = 40;

/** Parse one `- [ ] url | company | title | location | comp | posted: … | note: …` line. */
export function parsePipelineLine(line) {
  const m = line.match(/^- \[[ x]\] (\S+)(.*)$/);
  if (!m) return null;
  const [, url, rest] = m;
  const cells = rest.split(' | ').map((s) => s.trim()).filter((s, i) => i > 0 || s !== '');
  if (cells[0] === '') cells.shift();
  const labeled = {};
  const positional = [];
  for (const c of cells) {
    const lm = c.match(/^(posted|note|trust):\s*(.*)$/);
    if (lm) labeled[lm[1]] = lm[2];
    else positional.push(c);
  }
  const [company = '', title = '', location = '', comp = ''] = positional;
  return { url, company, title, location, comp, posted: labeled.posted || '', note: labeled.note || '' };
}

export function rowsForUrls(pipelineText, urls) {
  const wanted = new Set(urls);
  const byUrl = new Map();
  for (const line of pipelineText.split('\n')) {
    const row = parsePipelineLine(line.trim());
    if (row && wanted.has(row.url) && !byUrl.has(row.url)) byUrl.set(row.url, row);
  }
  return urls.map((u) => byUrl.get(u) || { url: u, company: '', title: u, location: '', comp: '', posted: '' });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackBlocks(rows, header) {
  const lines = rows.map((r) => {
    const bits = [isStartup(r) && '[startup/SME]', r.company && `*${esc(r.company)}*`, r.location && esc(r.location), r.posted && `posted ${esc(r.posted)}`, r.comp && esc(r.comp)].filter(Boolean);
    return `• <${r.url}|${esc(r.title || 'Open posting')}>\n   ${bits.join(' · ')}`;
  });
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } }];
  // Slack section text is capped at 3000 characters.
  let chunk = '';
  for (const l of lines) {
    if ((chunk + l).length > 2800) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      chunk = '';
    }
    chunk += `${l}\n`;
  }
  if (chunk) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
  return blocks;
}

async function postSlack(payload) {
  if (!SLACK) return;
  const res = await fetch(SLACK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) console.error(`Slack: HTTP ${res.status} ${await res.text()}`);
}

async function postNtfy(title, body, clickUrl) {
  if (!NTFY) return;
  const headers = { Title: title.replace(/[^\x20-\x7E]/g, ''), Tags: 'briefcase' };
  if (clickUrl) headers.Click = clickUrl;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, { method: 'POST', headers, body });
  if (!res.ok) console.error(`ntfy: HTTP ${res.status}`);
}

async function main() {
  if (!receiptPath || !existsSync(receiptPath)) {
    console.error('notify: no scan receipt found; the scan step probably failed before writing one.');
    process.exit(0);
  }
  const raw = readFileSync(receiptPath, 'utf8').trim();
  let receipt;
  try {
    receipt = JSON.parse(raw.split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
  } catch (err) {
    console.error(`notify: could not parse scan receipt: ${err.message}`);
    process.exit(0);
  }
  const urls = Array.isArray(receipt.added_urls) ? receipt.added_urls : [];
  const errors = Array.isArray(receipt.errors) ? receipt.errors : [];
  console.log(`scan: ${receipt.scanned ?? '?'} boards, ${receipt.found ?? '?'} postings seen, ${urls.length} new matches, ${errors.length} board errors`);

  if (!SLACK && !NTFY) {
    console.log('notify: no SLACK_WEBHOOK_URL or NTFY_TOPIC secret set; nothing sent.');
    return;
  }

  if (SEED) {
    const text = `Finance Job Radar is live. First scan indexed ${urls.length} matching roles across ${receipt.scanned ?? '?'} boards. From now on you will only be alerted about roles posted after this point.`;
    await postSlack({ text });
    await postNtfy('Finance Job Radar is live', text);
    return;
  }

  if (urls.length === 0) return;

  const pipelineText = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf8') : '';
  let rows = rowsForUrls(pipelineText, urls);
  // Firms just added by the weekly discovery job: their already-open roles are
  // recorded but not alerted, so a new firm doesn't flood the channel.
  if (SUPPRESS_FILE && existsSync(SUPPRESS_FILE)) {
    const quiet = new Set(readFileSync(SUPPRESS_FILE, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const before = rows.length;
    rows = rows.filter((r) => !quiet.has(r.company.trim().toLowerCase()));
    if (before !== rows.length) console.log(`notify: ${before - rows.length} roles at newly added firms recorded without alerts`);
  }
  // A firm's first appearance is silent: the roles it already has open are
  // recorded, not alerted (job-board roles, which carry "via ...", always alert).
  const FIRMS = 'data/seen-firms.json';
  const base = (c) => String(c || '').replace(/\s*\(.*\)$/, '').trim().toLowerCase();
  let seenFirms = existsSync(FIRMS) ? new Set(JSON.parse(readFileSync(FIRMS, 'utf8'))) : null;
  if (!seenFirms) {
    const newUrls = new Set(urls);
    seenFirms = new Set(pipelineText.split('\n').map((l) => parsePipelineLine(l.trim())).filter((r) => r && !newUrls.has(r.url)).map((r) => base(r.company)));
  }
  const firstTime = new Set(rows.filter((r) => !r.note && !seenFirms.has(base(r.company))).map((r) => base(r.company)));
  if (firstTime.size) {
    console.log(`notify: first scan for ${[...firstTime].join(', ')}: their open roles recorded without alerts`);
    rows = rows.filter((r) => r.note || !firstTime.has(base(r.company)));
  }
  for (const r of rowsForUrls(pipelineText, urls)) seenFirms.add(base(r.company));
  writeFileSync(FIRMS, `${JSON.stringify([...seenFirms].sort(), null, 1)}\n`);
  // Phone alerts only for firms on the Home Office register of licensed
  // sponsors (data/sponsors.json, refreshed weekly). Others stay on JOBS.md.
  const lic = loadSponsors();
  if (lic) {
    const held = rows.filter((r) => lic.get(baseName(r.company)) !== true);
    rows = rows.filter((r) => lic.get(baseName(r.company)) === true);
    if (held.length) console.log(`notify: ${held.length} role(s) not alerted, firm not on the sponsor register: ${[...new Set(held.map((r) => baseName(r.company)))].join(', ')}`);
  }
  if (rows.length === 0) return;
  const time = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

  for (let i = 0; i < rows.length; i += MAX_PER_MESSAGE) {
    const part = rows.slice(i, i + MAX_PER_MESSAGE);
    const header = `${rows.length} new finance role${rows.length === 1 ? '' : 's'} (${time} UK)${rows.length > MAX_PER_MESSAGE ? ` · part ${i / MAX_PER_MESSAGE + 1}` : ''}`;
    await postSlack({ text: header, blocks: slackBlocks(part, header) });
  }

  if (NTFY) {
    const first = rows[0];
    await postNtfy(newRolesTitle(rows), newRolesBody(rows), rows.length === 1 ? first.url : JOBS_URL);
  }
}

const baseName = (c) => String(c || '').replace(/\s*\(.*\)$/, '').replace(/^"|"$/g, '').trim();
export const isStartup = (r) => /startup\/SME/.test(r.note || '');
function loadSponsors() {
  try {
    const firms = JSON.parse(readFileSync('data/sponsors.json', 'utf8')).firms || {};
    return new Map(Object.entries(firms).map(([f, v]) => [f, v.licensed === true]));
  } catch { return null; }
}

function loadPicks() {
  try { return JSON.parse(readFileSync(PICKS_FILE, 'utf8')); } catch { return null; }
}

/** Group new roles by best-fitting CV, in the same order as JOBS.md (Other last). */
export function groupNewRoles(rows, picks = loadPicks()) {
  const assign = picks?.assign || {};
  const order = picks?.order || [];
  const names = picks?.names || {};
  const groups = new Map();
  for (const r of rows) {
    const a = assign[r.url] || { id: 'other', score: 0 };
    if (!groups.has(a.id)) groups.set(a.id, []);
    groups.get(a.id).push({ ...r, score: a.score });
  }
  const rank = (id) => (order.indexOf(id) === -1 ? 999 : order.indexOf(id));
  return [...groups.entries()]
    .sort((x, y) => rank(x[0]) - rank(y[0]))
    .map(([id, list]) => ({ id, name: id === 'other' ? 'Other' : (names[id] || id), roles: list.sort((a, b) => b.score - a.score) }));
}

/** Alert title, e.g. "16:23 scan: 3 new roles (Credit 2 · FP&A 1)". */
export function newRolesTitle(rows, picks = loadPicks(), at = new Date()) {
  const time = at.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
  const split = groupNewRoles(rows, picks).map((g) => `${g.name} ${g.roles.length}`).join(', ');
  return `${time} scan: ${rows.length} new role${rows.length === 1 ? '' : 's'} (${split})`;
}

/** Alert body: every new role under its CV heading (up to 4 per CV if there are many). */
export function newRolesBody(rows, picks = loadPicks()) {
  const groups = groupNewRoles(rows, picks);
  const perCv = rows.length <= 15 ? Infinity : 4;
  const lines = [];
  for (const g of groups) {
    lines.push(g.id === 'other' ? `OTHER (${g.roles.length}):` : `${g.name.toUpperCase()} CV (${g.roles.length}):`);
    for (const r of g.roles.slice(0, perCv)) lines.push(`• ${isStartup(r) ? '[startup/SME] ' : ''}${r.title} | ${r.company.replace(/\s*\(.*\)$/, '')}${r.location ? `, ${r.location.split(/[·,]/)[0].trim()}` : ''}`);
    if (g.roles.length > perCv) lines.push(`  +${g.roles.length - perCv} more`);
    lines.push('');
  }
  lines.push('Tap to open the jobs page (Latest scan section).');
  return lines.join('\n').trim();
}

/** Morning digest: top 2 roles for each CV, once a day. */
export function digestBody(picks) {
  const lines = [];
  for (const p of picks?.profiles || []) {
    lines.push(`${shortCv(p.cv).toUpperCase()} CV:`);
    if (!p.picks.length) lines.push('• nothing fresh');
    for (const x of p.picks.filter((x) => x.sponsor !== false)) lines.push(`• ${x.title} | ${x.company}${x.sponsor === true ? ' ✅' : ''}`);
  }
  return lines.join('\n');
}

async function maybeDigest() {
  if (!NTFY && !SLACK) return;
  const now = new Date();
  const ukHour = Number(now.toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }));
  const ukDate = now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const last = existsSync(DIGEST_FILE) ? readFileSync(DIGEST_FILE, 'utf8').trim() : '';
  if (ukHour < DIGEST_HOUR || last === ukDate) return;
  const picks = loadPicks();
  if (!picks?.profiles?.length) return;
  const body = digestBody(picks);
  await postNtfy('Morning picks: top 2 for each CV', body, JOBS_URL);
  await postSlack({ text: `Morning picks: top 2 for each CV\n${body}` });
  writeFileSync(DIGEST_FILE, `${ukDate}\n`);
  console.log('notify: morning digest sent');
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main().then(() => (SEED ? null : maybeDigest())).catch((err) => { console.error(err); process.exit(0); });
