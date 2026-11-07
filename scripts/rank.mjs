/**
 * rank.mjs: score matched roles against each CV profile in profiles.yml.
 *
 *   rankAll(rows, profiles, opts) -> Map(profileId -> [{...row, score, why}])
 *
 * rows: { url, company, title, location, posted } (from data/pipeline.md)
 * opts.sponsors: Map(company -> true/false) from data/sponsors.json
 * opts.now: Date (injectable for tests)
 */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word-ish match: "M&A" and "FP&A" contain no word characters at the edges we care about.
const kwRe = (k) => new RegExp(`(^|[^A-Za-z0-9])${esc(k)}([^A-Za-z0-9]|$)`, 'i');

export function compileProfiles(doc) {
  const compile = (list) => (list || []).map((k) => ({ k: String(k), re: kwRe(String(k)) }));
  return {
    profiles: (doc?.profiles || []).map((p) => ({ ...p, strongRe: compile(p.strong), relatedRe: compile(p.related) })),
    junior: compile(doc?.junior_words),
    experienced: compile(doc?.experienced_words),
  };
}

function daysSince(iso, now) {
  if (!iso) return null;
  const t = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

export function scoreRole(row, profile, ctx) {
  const t = row.title || '';
  const strong = profile.strongRe.filter((x) => x.re.test(t)).map((x) => x.k);
  // A related keyword that is just part of a matched strong keyword doesn't count twice.
  const related = profile.relatedRe
    .filter((x) => x.re.test(t) && !strong.some((s) => s.toLowerCase().includes(x.k.toLowerCase())))
    .map((x) => x.k);
  if (!strong.length && !related.length) return null;

  let score = strong.length * 10 + related.length * 4;
  const why = [...strong, ...related];
  if (ctx.junior.some((x) => x.re.test(t))) score += 4;
  else if (/\bassociate\b/i.test(t)) score += 1;
  if (ctx.experienced.some((x) => x.re.test(t))) { score -= 6; why.push('experienced hire?'); }

  const age = daysSince(row.posted, ctx.now);
  if (age !== null) {
    if (age <= 2) score += 4;
    else if (age <= 7) score += 2;
    else if (age > 30) score -= 3;
  }
  if (/mumbai|bombay|powai|bkc/i.test(row.location || '')) score += 1;
  const sponsor = ctx.sponsors?.get(baseFirm(row.company));
  // no sponsor-licence bonus on the India radar
  return { ...row, score, why, sponsor, age };
}

export function rankAll(rows, compiled, { sponsors = new Map(), now = Date.now(), perProfile = 2, maxPerFirm = 1 } = {}) {
  const ctx = { ...compiled, sponsors, now };
  const out = new Map();
  for (const p of compiled.profiles) {
    const scored = rows.map((r) => scoreRole(r, p, ctx)).filter(Boolean)
      .sort((a, b) => b.score - a.score || (a.age ?? 99) - (b.age ?? 99));
    // Spread the picks across firms: at most `maxPerFirm` per firm in the top list.
    const picks = [];
    const perFirm = new Map();
    for (const s of scored) {
      const key = s.company.replace(/\s*\(.*\)$/, '');
      if ((perFirm.get(key) || 0) >= maxPerFirm) continue;
      perFirm.set(key, (perFirm.get(key) || 0) + 1);
      picks.push(s);
      if (picks.length >= perProfile) break;
    }
    out.set(p.id, { profile: p, picks, total: scored.length });
  }
  return out;
}

/** Firm name as used for sponsor lookups: "Lloyds Banking Group (Graduates)" -> "Lloyds Banking Group". */
export const baseFirm = (name) => String(name || '').replace(/\s*\(.*\)$/, '').replace(/^"|"$/g, '').trim();
