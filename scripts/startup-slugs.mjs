#!/usr/bin/env node
// Finds the job-board slug for startups whose slug is wrong or unknown.
// Tries name variants on Greenhouse, Ashby, Lever (global + EU) and Workable,
// and writes reports/startup-slugs.md with a ready-to-paste YAML line for each
// hit. Run from the "Check startup list" workflow. Records nothing.
//
//   node scripts/startup-slugs.mjs --engine <career-ops dir> [--names "A,B,C"]
//
// Names checked: every company in companies_startups.yaml whose slug fails,
// plus the CANDIDATES below, minus firms already tracked in portals.yml.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : undefined; };
const ENGINE = arg('--engine') || process.env.CAREER_OPS_ENGINE;
const ROOT = process.env.CAREER_OPS_ROOT || process.cwd();
const { loadYaml } = await import(pathToFileURL(join(ENGINE, 'lib/yaml-document.mjs')).href);

// UK startups/scale-ups/SMEs with finance teams. Add names freely.
const CANDIDATES = `Razorpay, CRED, Groww, Zerodha, PhonePe, Paytm, Pine Labs, Juspay, Zeta, InCred, smallcase, Jupiter, Fi Money, Slice, Navi,
Upstox, Dhan, Angel One, Cashfree, PayU, BharatPe, MobiKwik, Lendingkart, KreditBee, Kissht, Moneyview, Rupeek, Indifi,
FlexiLoans, Credgenics, Perfios, Signzy, Setu, Open Financial, Khatabook, OkCredit, Jar, Fampay, Uni Cards, OneCard,
Scripbox, Kuvera, INDmoney, Wint Wealth, Stable Money, Vested, Appreciate, Dezerv, Neo Wealth, Centricity Wealth, Waterfield Advisors,
Avendus, Ambit, Equirus, o3 Capital, Veda Corporate Advisors, Spark Capital, Elara Capital, Nuvama, 360 ONE, Anand Rathi,
Motilal Oswal, IIFL, JM Financial, Kotak, ICICI Securities, HDFC Securities, Edelweiss, Aditya Birla Capital, Bajaj Finserv, Tata Capital,
Cholamandalam, Mahindra Finance, Poonawalla Fincorp, Piramal Finance, Northern Arc, Vivriti Capital, Yubi, CredAble, Progcap, Recur Club,
Klub, GetVantage, Velocity, Fibe, Capital Float, Ftcash, Mintifi, Tradeindia, Meesho, Flipkart, Swiggy, Zomato, Zepto, Ola, Nykaa, Lenskart,
Urban Company, Dream11, MPL, Games24x7, ShareChat, Unacademy, upGrad, PhysicsWallah, Byju's, Oyo, Delhivery, Rapido, Udaan, Ofbusiness,
Zetwerk, Infra.Market, Licious, boAt, Mamaearth, Sugar Cosmetics, CarDekho, Spinny, Cars24, NoBroker, Housing.com, PolicyBazaar, Acko,
Digit Insurance, Plum, Onsurity, Ditto, InsuranceDekho, Chargebee, Freshworks, Zoho, Postman, BrowserStack, Darwinbox, Leena AI,
Sprinklr, Druva, Innovaccer, Uniphore, MoEngage, CleverTap, WebEngage, Whatfix, Rippling, Atlassian, Stripe, Coinbase, CoinDCX, CoinSwitch,
Mudrex, WazirX, Polygon, Tower Research Capital, Graviton Research Capital, Quadeye, AlphaGrep, iRage, NK Securities, Futures First,
Optiver, Jane Street, Squarepoint, DE Shaw, WorldQuant, Millennium, Alpha Alternatives, Edelweiss Alternatives, Kotak Alternate, Nexus Venture Partners,
Peak XV, Accel, Elevation Capital, Blume Ventures, Chiratae, Matrix Partners, Lightspeed, Stellaris, 3one4 Capital, Kae Capital, Chryscapital,
Multiples, Kedaara, True North, Everstone, ChrysCapital, Gaja Capital, Evalueserve, Acuity Knowledge Partners, CRISIL, ICRA, CARE Ratings,
India Ratings, Tracxn, Venture Intelligence, Kristal.AI, Simpl, LazyPay, Easebuzz, Decentro, M2P Fintech, Hyperface, Falcon, Neokred`
  .split(',').map((s) => s.trim()).filter(Boolean);

const UA = 'finance-job-radar (slug finder)';
const norm = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function variants(name) {
  const n = norm(name.replace(/\.com\b/i, ''));
  const words = n.split(' ');
  const base = [...new Set([words.join(''), words.join('-'), words[0]])].filter((v) => v.length >= 2);
  const out = new Set(base);
  for (const b of base.slice(0, 2)) for (const suf of ['hq', 'uk', 'ltd', 'careers', 'jobs', 'group', 'app', 'io', 'technologies']) out.add(b + suf);
  out.add(n.replace(/\.com/, 'com').replace(/ /g, ''));
  return [...out].slice(0, 14);
}

const PROBES = [
  ['greenhouse', (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (j) => j?.jobs, (j) => j.location?.name],
  ['ashby', (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`, (j) => j?.jobs, (j) => [j.location, j.address?.postalAddress?.addressCountry].join(' ')],
  ['lever', (s) => `https://api.lever.co/v0/postings/${s}?mode=json`, (j) => (Array.isArray(j) ? j : null), (j) => j.categories?.location],
  ['lever-eu', (s) => `https://api.eu.lever.co/v0/postings/${s}?mode=json`, (j) => (Array.isArray(j) ? j : null), (j) => j.categories?.location],
  ['workable', (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`, (j) => (j?.name ? j.jobs || [] : null), (j) => [j.city, j.country].join(' ')],
];
const UK = /\b(india|mumbai|bombay|bengaluru|bangalore|gurugram|gurgaon|noida|delhi|hyderabad|pune|chennai|kolkata|ahmedabad|gift city|nagpur|jaipur|remote)\b/i; // India radar

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function find(name) {
  for (const slug of variants(name)) {
    for (const [ats, url, list, loc] of PROBES) {
      const json = await get(url(slug));
      const jobs = json && list(json);
      if (!jobs || !jobs.length) continue; // empty boards aren't worth adding (and some APIs answer 200 for anything)
      return { name, ats, slug, jobs: jobs.length, uk: jobs.filter((j) => UK.test(String(loc(j) || ''))).length };
    }
  }
  return { name, ats: null };
}

const listed = loadYaml(readFileSync(join(ROOT, 'companies_startups.yaml'), 'utf8'))?.companies || [];
const tracked = new Set((loadYaml(readFileSync(join(ROOT, 'portals.yml'), 'utf8'))?.tracked_companies || []).map((c) => norm(c.name)));
const working = new Set();
try {
  for (const line of readFileSync(join(ROOT, 'reports/startups-check.md'), 'utf8').split('\n')) {
    const m = line.match(/^\| (.+?) \| \w+ \/ \S+ \| ok \| (\d+)/);
    if (m && Number(m[2]) > 0) working.add(norm(m[1]));
  }
} catch {}
const extra = arg('--names') ? arg('--names').split(',').map((s) => s.trim()) : [];
const names = [...new Set([...listed.map((c) => c.name.replace(/ Workable$/, '')), ...CANDIDATES, ...extra])]
  .filter((n) => !tracked.has(norm(n)) && !working.has(norm(n)));

const results = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (i < names.length) { const n = names[i++]; results.push(await find(n)); } }));
results.sort((a, b) => (b.uk || -1) - (a.uk || -1) || a.name.localeCompare(b.name));

const hits = results.filter((r) => r.ats);
const lines = [
  '# Startup slug finder', '',
  `Tried ${names.length} names on Greenhouse, Ashby, Lever and Workable. Found ${hits.length}.`,
  'Copy the lines you want into companies_startups.yaml. Check the company is the right one (same-name firms exist).', '',
  '| Company | Found on | India jobs / all | YAML line |', '|---|---|---|---|',
  ...hits.map((r) => {
    const ats = r.ats === 'lever-eu' ? 'lever' : r.ats;
    const region = r.ats === 'lever-eu' ? ', region: eu' : '';
    return `| ${r.name} | ${r.ats} / ${r.slug} | ${r.uk} / ${r.jobs} | \`- { name: ${r.name}, ats: ${ats}, slug: ${r.slug}${region} }\` |`;
  }),
  '', '## Not found on any of the four', '',
  results.filter((r) => !r.ats).map((r) => r.name).sort().join(', ') || '(none)', '',
];
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports/startup-slugs.md'), lines.join('\n'));
console.log(`startup-slugs: ${names.length} names tried, ${hits.length} found`);
