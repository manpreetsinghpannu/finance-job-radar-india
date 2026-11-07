#!/usr/bin/env node
/**
 * find-ats.mjs: find a scannable hiring-system board for companies that
 * career-ops' discover-ats.mjs could not resolve from the name alone.
 *
 * For each unresolved company it opens the careers page / website (plus a few
 * likely careers links found there) and looks for links to a hiring system
 * career-ops can scan: Workday, Oracle Recruiting Cloud, Eightfold, Avature,
 * iCIMS, Taleo, Greenhouse, Lever, Ashby, SmartRecruiters, Workable,
 * Teamtailor, Pinpoint, Phenom, Radancy, ...
 *
 * Every candidate is checked with career-ops' own provider registry before it
 * is kept, so only entries the scanner can actually read are added.
 *
 * Usage:
 *   node scripts/find-ats.mjs --engine <career-ops dir> --companies companies.yml \
 *        --discover <discover-ats JSON output> --portals portals.yml \
 *        --report reports/discovery.md [--write]
 *
 * Without --write it only prints what it would add. Zero AI tokens.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const ENGINE = path.resolve(opt('--engine', process.env.CAREER_OPS_ENGINE || '../career-ops'));
const COMPANIES = opt('--companies', 'companies.yml');
const DISCOVER = opt('--discover');
const PORTALS = opt('--portals', 'portals.yml');
const REPORT = opt('--report', 'reports/discovery.md');
const WRITE = args.includes('--write');
const ONLY = opt('--only'); // debug: one company name

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 2_000_000;
const MAX_FOLLOW_LINKS = 4;
const CONCURRENCY = 6;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ------------------------------------------------------------ ATS detection
/**
 * Each rule turns a match in a page's HTML (or final URL) into a portals.yml
 * entry. Order matters: the first rule that matches wins, so specific,
 * directly-scannable boards come before generic page-builder markers.
 */
export const RULES = [
  {
    id: 'workday',
    re: /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g,
    build: (m) => (/^(wday|job|jobs|login|en-us)$/i.test(m[3]) ? null : { careers_url: `https://${m[1]}.${m[2]}.myworkdayjobs.com/${m[3]}` }),
  },
  {
    id: 'workday-site',
    re: /https?:\/\/(wd\d+)\.myworkdaysite\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/g,
    build: (m) => ({ careers_url: `https://${m[1]}.myworkdaysite.com/recruiting/${m[2]}/${m[3]}` }),
  },
  {
    id: 'oraclecloud',
    re: /https?:\/\/([a-z0-9.-]+\.oraclecloud\d*\.com)\/hcmUI\/CandidateExperience\/([a-z]{2}(?:-[A-Za-z]{2})?)\/sites\/([A-Za-z0-9_]+)/g,
    build: (m) => ({ careers_url: `https://${m[1]}/hcmUI/CandidateExperience/${m[2]}/sites/${m[3]}/jobs` }),
  },
  {
    id: 'eightfold',
    re: /https?:\/\/([a-z0-9-]+)\.eightfold\.ai/g,
    build: (m) => (/^(www|app)$|sandbox|-qa|-dev|-test|-stg|staging/.test(m[1]) ? null : { careers_url: `https://${m[1]}.eightfold.ai/careers` }),
  },
  {
    id: 'avature',
    re: /https?:\/\/([a-z0-9-]+)\.avature\.net/g,
    build: (m) => (/^(www|recruiting360|demo|sandbox)$|sandbox|-qa|-test/.test(m[1]) ? null : { careers_url: `https://${m[1]}.avature.net/careers` }),
  },
  {
    id: 'icims',
    re: /https?:\/\/((?:[a-z0-9-]+-)?[a-z0-9-]+)\.icims\.com/g,
    build: (m) => (/^(www|cdn|login|cookie-policy-scripts|static|assets)$|script|cookie/.test(m[1]) ? null : { careers_url: `https://${m[1]}.icims.com/jobs/search?ss=1` }),
  },
  {
    id: 'taleo',
    re: /https?:\/\/([a-z0-9-]+)\.taleo\.net\/careersection\/([A-Za-z0-9_-]+)\//g,
    build: (m) => ({ careers_url: `https://${m[1]}.taleo.net/careersection/${m[2]}/jobsearch.ftl` }),
  },
  {
    id: 'greenhouse',
    re: /https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/g,
    build: (m) => (/^(embed|jobs|v1)$/.test(m[1]) ? null : { careers_url: `https://job-boards.greenhouse.io/${m[1]}` }),
  },
  {
    id: 'greenhouse-embed',
    re: /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([A-Za-z0-9_-]+)/g,
    build: (m) => ({ careers_url: `https://job-boards.greenhouse.io/${m[1]}` }),
  },
  {
    id: 'lever',
    re: /https?:\/\/jobs\.(eu\.)?lever\.co\/([A-Za-z0-9_.-]+)/g,
    build: (m) => ({ careers_url: `https://jobs.${m[1] || ''}lever.co/${m[2]}` }),
  },
  {
    id: 'ashby',
    re: /https?:\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/g,
    build: (m) => (m[1] === 'api' ? null : { careers_url: `https://jobs.ashbyhq.com/${m[1]}` }),
  },
  {
    id: 'smartrecruiters',
    re: /https?:\/\/(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g,
    build: (m) => (/^(oneclick-ui|widget|api|static|embed)$/i.test(m[1]) ? null : { careers_url: `https://careers.smartrecruiters.com/${m[1]}` }),
  },
  {
    id: 'workable',
    re: /https?:\/\/apply\.workable\.com\/([A-Za-z0-9_-]+)/g,
    build: (m) => (m[1] === 'api' || m[1] === 'j' || m[1].length < 3 ? null : { careers_url: `https://apply.workable.com/${m[1]}` }),
  },
  {
    id: 'teamtailor',
    re: /https?:\/\/([a-z0-9-]+)\.teamtailor\.com/g,
    build: (m) => (/^(www|app|career|assets)$/.test(m[1]) ? null : { careers_url: `https://${m[1]}.teamtailor.com/jobs` }),
  },
  {
    id: 'pinpoint',
    re: /https?:\/\/([a-z0-9-]+)\.pinpointhq\.com/g,
    build: (m) => (m[1] === 'www' ? null : { careers_url: `https://${m[1]}.pinpointhq.com` }),
  },
  {
    id: 'recruitee',
    re: /https?:\/\/([a-z0-9-]+)\.recruitee\.com/g,
    build: (m) => (m[1] === 'www' ? null : { careers_url: `https://${m[1]}.recruitee.com` }),
  },
  {
    id: 'personio',
    re: /https?:\/\/([a-z0-9-]+)\.jobs\.personio\.(de|com)/g,
    build: (m) => ({ careers_url: `https://${m[1]}.jobs.personio.${m[2]}` }),
  },
  {
    id: 'bamboohr',
    re: /https?:\/\/([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/g,
    build: (m) => ({ careers_url: `https://${m[1]}.bamboohr.com/careers` }),
  },
];

/** Branded career sites: the provider must be named explicitly. */
export const BRANDED = [
  { id: 'phenom', re: /cdn\.phenompeople\.com|phenompeople|"phApp"|window\.phApp/i },
  { id: 'radancy', re: /tbcdn\.talentbrew\.com|talentbrew|radancy/i },
  // SAP SuccessFactors Recruiting Marketing (ex-jobs2web) branded career sites
  { id: 'successfactors', re: /jobs2web|rmkcdn|\/tile-search-results|rmk-map|successfactors\.(com|eu)/i },
];

/** Systems we can see but the scanner cannot read without manual setup. */
export const REPORT_ONLY = [
  { id: 'brassring', re: /brassring\.com|kenexa/i },
  { id: 'tal.net', re: /\.tal\.net/i },
  { id: 'cornerstone', re: /csod\.com/i },
];

export function detectInText(text) {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      const built = rule.build(m);
      if (built) return { vendor: rule.id, ...built };
    }
  }
  return null;
}

// --------------------------------------------------------------- fetching
async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/html|xml|text/.test(type)) return { url, finalUrl: res.url, status: res.status, html: '' };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    return { url, finalUrl: res.url, status: res.status, html: Buffer.concat(chunks).toString('utf8') };
  } catch (err) {
    return { url, finalUrl: url, status: 0, html: '', error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const CAREER_LINK_RE = /href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
const CAREER_WORDS = /(career|jobs?\b|vacanc|opportunit|join[- ]?us|work[- ]with[- ]us|search[- ]jobs|open[- ]roles|current[- ]openings)/i;

export function careerLinks(html, baseUrl) {
  const out = new Set();
  let m;
  CAREER_LINK_RE.lastIndex = 0;
  while ((m = CAREER_LINK_RE.exec(html)) !== null && out.size < 20) {
    const [, href, text] = m;
    if (!CAREER_WORDS.test(href) && !CAREER_WORDS.test(text.replace(/<[^>]+>/g, ' '))) continue;
    try {
      const u = new URL(href, baseUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (/\.(pdf|jpg|png|svg|css|js)(\?|$)/i.test(u.pathname)) continue;
      out.add(u.href);
    } catch { /* bad href */ }
  }
  return [...out];
}

function startUrls(company) {
  const urls = [];
  if (company.careers) urls.push(company.careers);
  if (company.website) {
    const host = company.website.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const bare = host.replace(/^www\./, '');
    urls.push(`https://${host.includes('/') ? host : `www.${bare}`}`);
    if (!host.includes('/')) {
      urls.push(`https://careers.${bare}`, `https://jobs.${bare}`, `https://www.${bare}/careers`);
    }
  }
  return [...new Set(urls)];
}

async function investigate(company, validate) {
  const tried = [];
  const seen = new Set();
  let branded = null;
  let reportOnly = null;

  const consider = (page) => {
    const text = `${page.finalUrl}\n${page.html}`;
    const hit = detectInText(text);
    if (hit) {
      const entry = { name: company.name, careers_url: hit.careers_url };
      if (validate(entry)) return { ...entry, vendor: hit.vendor, foundOn: page.url };
    }
    if (!branded && page.html) {
      const b = BRANDED.find((r) => r.re.test(page.html));
      if (b) branded = { vendor: b.id, origin: new URL(page.finalUrl).origin, foundOn: page.url };
    }
    if (!reportOnly && page.html) {
      const r = REPORT_ONLY.find((x) => x.re.test(text));
      if (r) reportOnly = { vendor: r.id, foundOn: page.url };
    }
    return null;
  };

  const queue = startUrls(company);
  for (let i = 0; i < queue.length && tried.length < 10; i++) {
    const url = queue[i];
    if (seen.has(url)) continue;
    seen.add(url);
    const page = await fetchPage(url);
    tried.push(`${url} → ${page.status || page.error}`);
    if (page.finalUrl) seen.add(page.finalUrl);
    const found = consider(page);
    if (found) return { status: 'found', ...found, tried };
    // Follow a few careers-looking links from the first pages that loaded.
    if (page.html && i < 3) {
      for (const link of careerLinks(page.html, page.finalUrl).slice(0, MAX_FOLLOW_LINKS)) {
        if (!seen.has(link) && !queue.includes(link)) queue.push(link);
      }
    }
  }

  if (branded) {
    const entry = { name: company.name, careers_url: branded.origin, provider: branded.vendor };
    if (validate(entry)) return { status: 'found', ...entry, vendor: branded.vendor, foundOn: branded.foundOn, tried };
  }
  return { status: 'unresolved', vendor: reportOnly?.vendor || null, foundOn: reportOnly?.foundOn || null, tried };
}

// ------------------------------------------------------------ portals I/O
const norm = (u) => String(u || '').toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');

function yamlEntry(e) {
  const lines = [`  - name: ${JSON.stringify(e.name)}`, `    careers_url: ${e.careers_url}`];
  if (e.provider) lines.push(`    provider: ${e.provider}`);
  lines.push(`    # added by find-ats (${e.vendor}) ${new Date().toISOString().slice(0, 10)}`);
  return lines.join('\n');
}

async function runPool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

// ------------------------------------------------------------------- main
async function main() {
  const { loadYaml } = await import(pathToFileURL(path.join(ENGINE, 'lib/yaml-document.mjs')).href);
  const { loadProviders, resolveProvider } = await import(pathToFileURL(path.join(ENGINE, 'providers/_registry.mjs')).href);
  const providers = await loadProviders(path.join(ENGINE, 'providers'));

  const validate = (entry) => {
    const r = resolveProvider(entry, providers, { skipIds: ['local-parser'] });
    return Boolean(r && r.provider);
  };

  const companyDoc = loadYaml(readFileSync(COMPANIES, 'utf8'));
  const allCompanies = (companyDoc?.companies || []).filter((c) => c && c.name);

  const portalsText = readFileSync(PORTALS, 'utf8');
  const portals = loadYaml(portalsText) || {};
  const tracked = Array.isArray(portals.tracked_companies) ? portals.tracked_companies : [];
  // Switched-off entries don't count as tracked, so a firm whose board died can be re-found.
  const trackedNames = new Set(tracked.filter((t) => t.enabled !== false).map((t) => String(t.name || '').toLowerCase()));
  const trackedUrls = new Set(tracked.map((t) => norm(t.careers_url)));

  // Which companies still need work: unresolved by discover-ats, and not already tracked.
  let unresolvedNames = null;
  if (DISCOVER && existsSync(DISCOVER)) {
    try {
      const d = JSON.parse(readFileSync(DISCOVER, 'utf8'));
      unresolvedNames = new Set((d.unresolved || []).map((u) => String(u.name || u.company || u).toLowerCase()));
    } catch (err) {
      console.error(`could not read ${DISCOVER}: ${err.message}`);
    }
  }
  const todo = allCompanies.filter((c) => {
    const key = c.name.toLowerCase();
    if (ONLY && key !== ONLY.toLowerCase()) return false;
    if ([...trackedNames].some((n) => n === key || n.startsWith(`${key} (`))) return false;
    if (unresolvedNames && !unresolvedNames.has(key)) return false;
    return true;
  });

  console.error(`find-ats: checking ${todo.length} companies`);
  const results = await runPool(todo, async (c) => ({ company: c, ...(await investigate(c, validate)) }), CONCURRENCY);

  const added = [];
  for (const r of results) {
    if (r.status !== 'found') continue;
    if (trackedUrls.has(norm(r.careers_url))) { r.status = 'duplicate'; continue; }
    trackedUrls.add(norm(r.careers_url));
    added.push(r);
  }

  if (WRITE && added.length) {
    const block = `${added.map(yamlEntry).join('\n')}\n`;
    const next = `${portalsText.replace(/\s*$/, '\n')}${block}`;
    const parsed = loadYaml(next);
    const count = Array.isArray(parsed?.tracked_companies) ? parsed.tracked_companies.length : -1;
    if (count === tracked.length + added.length) {
      writeFileSync(PORTALS, next, 'utf8');
    } else {
      console.error('find-ats: appended YAML did not parse as expected; portals.yml left unchanged (is tracked_companies still the last key?)');
      process.exitCode = 1;
    }
  }

  // Report
  const unresolved = results.filter((r) => r.status === 'unresolved');
  const lines = [
    `# Discovery report: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Checked ${results.length} companies that the name lookup could not resolve.`,
    `Added to portals.yml: **${WRITE ? added.length : 0}**${WRITE ? '' : ` (preview: ${added.length} would be added)`}. Still not scannable: **${unresolved.length}**.`,
    '',
    '## Added',
    '',
    ...(added.length ? added.map((a) => `- **${a.name}**: ${a.vendor} → ${a.careers_url}`) : ['- none this run']),
    '',
    '## Not scannable automatically',
    '',
    'These firms use a careers site the scanner cannot read yet (or the site blocked the check).',
    'Set a job alert on their own site, or follow them on LinkedIn.',
    '',
    '| Company | What was seen | Where |',
    '|---|---|---|',
    ...unresolved.map((u) => `| ${u.company.name} | ${u.vendor || 'no hiring system link found'} | ${u.foundOn || (u.company.careers || u.company.website || '')} |`),
    '',
  ];
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log(JSON.stringify({ checked: results.length, added: added.map(({ name, careers_url, vendor }) => ({ name, careers_url, vendor })), unresolved: unresolved.map((u) => u.company.name) }, null, 2));
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
