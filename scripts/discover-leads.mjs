#!/usr/bin/env node
// discover-leads.mjs — Droptimize automated daily lead discovery (committed; runs in CI).
//
// The budget-capped twin of SureScout's win-back enrichment. Each day it tops every ACTIVE
// territory back up to its `daily_target` OPEN leads (status new/in_progress) and no further — so a
// day where nothing was worked costs $0, and the Google Places spend self-limits to the operator's
// pace. Discovery widens the territory's radius ring as the current ring mines out, exactly as the
// schema comment describes, until max_radius_km, then marks the territory 'exhausted'.
//
// Territories run as an ORDERED CHAIN: only 'active' ones discover; 'paused' ones wait their turn.
// When a territory mines out its full radius ring (reaches max_radius_km with nothing new) it is
// marked 'exhausted' and the next 'paused' territory by sort_order is auto-activated. So discovery
// works one metro to completion, then expands to the next (San Diego → Orange County → LA → ...).
//
// Stays inside Droptimize's 40% share (~2,000/mo) of the shared free Google Places quota:
//   - Only PAID call is Google Places (Text Search to find shops + Place Details for the website).
//   - PSI (audit), header fetch, and email scrape are free / separate quotas.
//   - Dedupe by place_id AND host BEFORE spending a Place Details call, so dupes cost only the
//     cheap shared Text Search page, never per-lead Details.
//   - Hard per-run cap on Place Details (DISCOVER_CAP, default = sum of territory needs, ceiling 50).
//
// Safe by construction: the workflow holds all spend until 2026-07-01 (Google budget reset); this
// script no-ops cleanly when keys are missing; DRY_RUN=1 reports each territory's plan (how many it
// would discover) and makes NO Google Places calls and NO DB writes.
//
// Usage (local):  set -a; . _private/.env; set +a; DRY_RUN=1 node scripts/discover-leads.mjs
//   env: SUPABASE_DROPTIMIZE_URL/_SERVICE_KEY (CI) or SUPABASE_URL/SUPABASE_SERVICE_KEY (local),
//        PLACES_KEY (legacy Places), PSI_KEY (PageSpeed). Flags: DRY_RUN=1, DISCOVER_CAP=<n>,
//        DISCOVER_MODE=topup|fresh (default topup), FULL_PSI=1 (median-of-5, slower/honest).

const SB = process.env.SUPABASE_DROPTIMIZE_URL || process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_DROPTIMIZE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const PLACES_KEY = process.env.PLACES_KEY;
const PSI_KEY = process.env.PSI_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const FULL_PSI = process.env.FULL_PSI === '1';
const MODE = (process.env.DISCOVER_MODE || 'topup').toLowerCase();   // topup = refill to target; fresh = always discover up to target
const CAP_OVERRIDE = parseInt(process.env.DISCOVER_CAP || '', 10);   // hard ceiling on Place Details calls this run
const HARD_DETAILS_CEILING = 70;                                     // absolute backstop regardless of need (covers a 65/day territory)
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36';

if (!SB || !SKEY) { console.error('missing SUPABASE_(DROPTIMIZE_)URL / SERVICE_KEY'); process.exit(1); }
if (!PLACES_KEY && !DRY_RUN) { console.error('missing PLACES_KEY (set DRY_RUN=1 to test without Places)'); process.exit(1); }
if (!PSI_KEY) console.error('warn: no PSI_KEY — audits will score 0 across PSI categories');

const log = (...a) => console.log(...a);
const sb = (path, opts = {}) => fetch(SB + '/rest/v1/' + path, { ...opts, headers: { apikey: SKEY, Authorization: 'Bearer ' + SKEY, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

// ---------------------------------------------------------------------------- utils
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hostOf(url) { try { const h = new URL(url).hostname.toLowerCase(); return h.startsWith('www.') ? h.slice(4) : h; } catch { return ''; } }
async function fetchText(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, signal: ctrl.signal });
    const body = opts.headOnly ? '' : await res.text();
    return { ok: res.ok, status: res.status, headers: res.headers, body, url: res.url };
  } catch (e) { return { ok: false, status: 0, headers: new Headers(), body: '', error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
async function fetchJson(url) {
  try { const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } }); if (!res.ok) return { _httpError: res.status }; return await res.json(); }
  catch (e) { return { _error: String(e.message || e) }; }
}

// ---------------------------------------------------------------------------- repair-shop deny-list
// Auto-repair shops are the operator's OWN company territory (SureScout), never a Droptimize target.
const REPAIR_TYPE = new Set(['car_repair', 'car_dealer', 'car_wash']);
const REPAIR_NAME_RX = /\b(auto|automotive|mechanic|tire|tyre|transmission|collision|body\s*shop|car\s*care|brake|muffler|lube|smog|radiator|detailing|motorworks|engine)\b/i;
const isRepairShop = (name, types = []) => types.some((t) => REPAIR_TYPE.has(t)) || REPAIR_NAME_RX.test(name || '');

// ---------------------------------------------------------------------------- Google Places (legacy)
const INDUSTRY_QUERY = { legal: 'law firm', accounting: 'accounting firm', other: 'business' };

// One Text Search page (1 billable call). Returns {results, nextPageToken}. location+radius bias the
// search to the territory ring; radius is capped at the 50km legacy maximum.
async function textSearchPage(query, lat, lng, radiusM, pageToken) {
  const u = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
  u.searchParams.set('query', query);
  u.searchParams.set('key', PLACES_KEY);
  if (lat != null && lng != null) { u.searchParams.set('location', `${lat},${lng}`); u.searchParams.set('radius', String(Math.min(Math.round(radiusM), 50000))); }
  if (pageToken) u.searchParams.set('pagetoken', pageToken);
  const data = await fetchJson(u.toString());
  if (data._error || data._httpError || (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) {
    throw new Error(`Places textsearch failed: ${data.status || data._httpError || data._error}`);
  }
  return { results: data.results || [], nextPageToken: data.next_page_token || null };
}

// One Place Details call (1 billable call) — the website/phone the Text Search omits.
async function placeDetails(placeId) {
  const u = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  u.searchParams.set('place_id', placeId);
  u.searchParams.set('fields', 'name,website,formatted_phone_number,formatted_address');
  u.searchParams.set('key', PLACES_KEY);
  const d = await fetchJson(u.toString());
  return d.result || {};
}

// ---------------------------------------------------------------------------- email scrape (free)
const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMAIL_JUNK = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$|@(example|sentry|wix|squarespace|godaddy)\./i;
function extractEmails(html, host) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) found.add(m[1].toLowerCase());
  for (const m of html.matchAll(EMAIL_RX)) found.add(m[0].toLowerCase());
  const clean = [...found].filter((e) => !EMAIL_JUNK.test(e));
  const sameDomain = clean.filter((e) => host && e.endsWith('@' + host));
  return [...new Set([...sameDomain, ...clean])].slice(0, 5);
}
async function enrichEmail(website) {
  const host = hostOf(website);
  const emails = new Set();
  for (const u of [website, website.replace(/\/+$/, '') + '/contact', website.replace(/\/+$/, '') + '/contact-us']) {
    const r = await fetchText(u, { timeout: 12000 });
    if (r.body) extractEmails(r.body, host).forEach((e) => emails.add(e));
    if (emails.size) break;
  }
  return [...emails].slice(0, 5);
}

// ---------------------------------------------------------------------------- qualify (security + PSI, free)
async function securityScore(url) {
  const r = await fetchText(url, { timeout: 15000 });
  const has = (name) => (r.headers.get(name) ? 1 : 0);
  const headers = { hsts: has('strict-transport-security'), csp: has('content-security-policy'), x_content_type_options: has('x-content-type-options'), x_frame_options: has('x-frame-options'), referrer_policy: has('referrer-policy'), permissions_policy: has('permissions-policy') };
  const pass = Object.values(headers).reduce((a, b) => a + b, 0);
  return { status: r.status, score: Math.round((pass * 100) / 6), headers };
}
const PSI_CATS = ['seo', 'performance', 'best-practices', 'accessibility'];
async function psiOnce(url) {
  if (!PSI_KEY) return {};
  const u = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  u.searchParams.set('url', url); u.searchParams.set('strategy', 'mobile');
  for (const c of ['SEO', 'PERFORMANCE', 'BEST_PRACTICES', 'ACCESSIBILITY']) u.searchParams.append('category', c);
  u.searchParams.set('key', PSI_KEY);
  return fetchJson(u.toString());
}
function scoresFromPsi(data) { const c = data?.lighthouseResult?.categories || {}; const row = {}; for (const k of PSI_CATS) row[k] = Math.round((c[k]?.score ?? 0) * 100); return row; }
function topFailing(data, catKey, limit = 6) {
  const cats = data?.lighthouseResult?.categories || {}, audits = data?.lighthouseResult?.audits || {};
  const out = [];
  for (const ref of cats[catKey]?.auditRefs || []) { if (!ref.weight) continue; const a = audits[ref.id]; if (!a || a.score == null || a.score >= 0.9) continue; out.push({ id: ref.id, title: a.title || ref.id, score: a.score, displayValue: a.displayValue || '', weight: ref.weight }); }
  out.sort((x, y) => x.score - y.score || y.weight - x.weight);
  return out.slice(0, limit);
}
async function qualify(url) {
  const sec = await securityScore(url);
  const runs = []; let rep = null; const n = FULL_PSI ? 5 : 1;
  for (let i = 0; i < n; i++) { const d = await psiOnce(url); if (d?.lighthouseResult) { runs.push(scoresFromPsi(d)); if (!rep) rep = d; } if (n > 1) await sleep(1500); }
  const median = (arr) => (arr.length ? arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] : 0);
  const psi = {}; for (const k of PSI_CATS) psi[k] = runs.length ? median(runs.map((r) => r[k])) : 0;
  const scores = { seo: psi.seo, performance: psi.performance, best_practices: psi['best-practices'], accessibility: psi.accessibility, security: sec.score };
  return { scores, security_headers: sec.headers, http_status: sec.status, psi_runs: runs.length,
    failing_audits: rep ? { seo: topFailing(rep, 'seo'), performance: topFailing(rep, 'performance'), best_practices: topFailing(rep, 'best-practices'), accessibility: topFailing(rep, 'accessibility') } : {} };
}

// ---------------------------------------------------------------------------- rank + hook + email
const WEIGHTS = {
  legal: { security: 0.40, seo: 0.20, performance: 0.20, accessibility: 0.10, best_practices: 0.10 },
  accounting: { security: 0.40, seo: 0.20, performance: 0.20, accessibility: 0.10, best_practices: 0.10 },
  other: { security: 0.20, seo: 0.30, performance: 0.30, accessibility: 0.10, best_practices: 0.10 },
};
function painScore(scores, industry) { const w = WEIGHTS[industry] || WEIGHTS.other; let pain = 0; for (const k of Object.keys(w)) pain += w[k] * (100 - (scores[k] ?? 0)); return Math.round(pain); }
function leadHook(scores, industry) {
  const pii = industry === 'legal' || industry === 'accounting';
  if (scores.security <= 50) return pii
    ? `No security headers — every modern browser checks these, and for a firm holding client records it reads as a data-handling risk. This is the lead.`
    : `Missing the security headers browsers now check — an easy, visible credibility gap.`;
  if (scores.performance <= 50) return `Slow on mobile (Performance ${scores.performance}/100) — most local searches are on a phone, and this is where they bounce.`;
  if (scores.seo <= 80) return `Missing the structured data Google reads (SEO ${scores.seo}/100) — competitors who did the basics outrank them.`;
  return `Several fixable gaps; weakest is security ${scores.security}/100.`;
}
// A site already scoring well is NOT a lead — emailing it is the spammy move and tanks reply rates.
function isContactable(scores) { const avg = (scores.seo + scores.performance + scores.best_practices + scores.accessibility + scores.security) / 5; return scores.security < 100 || avg < 90; }

// Deterministic, on-brand cold email (no AI, no em-dashes/italics). Composed directly from the scores
// so the copy is always clean. The operator reviews/edits before anything is sent (this only drafts).
function buildEmail(name, host, scores, industry) {
  const pii = industry === 'legal' || industry === 'accounting';
  // The single most contactable issue, as a clean noticed-clause.
  const lead = scores.security <= 50
    ? (pii
        ? `it is missing the security headers every modern browser now checks for, which for a firm holding client records reads as a data-handling risk`
        : `it is missing the security headers browsers now check for, a visible credibility gap`)
    : scores.performance <= 50 ? `it loads slowly on mobile (Performance ${scores.performance}/100), where most local searches happen`
    : scores.seo <= 80 ? `it is missing the structured data Google reads (SEO ${scores.seo}/100), so competitors who did the basics outrank it`
    : `a few fixable gaps, the weakest being security at ${scores.security}/100`;
  // Up to two quick-win items for the second line.
  const weak = [];
  if (scores.security < 100) weak.push('the security headers browsers check for');
  if (scores.performance <= 70) weak.push('mobile load speed');
  if (scores.seo <= 80) weak.push('the SEO basics Google ranks on');
  const list = weak.slice(0, 2).join(' and ');
  const subject = scores.security <= 50 ? `${name}: a security gap on your website` : `${name}: a few fixable things on ${host}`;
  const body = `Hi ${name} team,

I run Droptimize, where I audit local business websites. I ran a quick check on ${host} and noticed ${lead}.

${list ? `The quickest wins are ${list}. ` : ''}None of this is visible to you day to day, but it quietly costs trust and search ranking.

Happy to send a free, no-obligation breakdown of exactly what I found and how to fix it. Want me to send it over?

Droptimize`;
  return { subject, body };
}

// ---------------------------------------------------------------------------- DB
async function loadKnown() {
  const hosts = new Set(), placeIds = new Set();
  for (let off = 0; ; off += 1000) {
    const r = await sb(`leads?select=host,place_id&order=id.asc&limit=1000&offset=${off}`);
    const j = await r.json(); if (!Array.isArray(j) || !j.length) break;
    for (const l of j) { if (l.host) hosts.add(l.host); if (l.place_id) placeIds.add(l.place_id); }
    if (j.length < 1000) break;
  }
  return { hosts, placeIds };
}
async function countOpen(territoryId) {
  const r = await sb(`leads?select=id&territory_id=eq.${territoryId}&status=in.(new,in_progress)`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const cr = r.headers.get('content-range') || '';   // "0-0/<total>"
  const m = /\/(\d+)$/.exec(cr); return m ? parseInt(m[1], 10) : 0;
}
async function loadTerritories() { const r = await sb(`territories?select=*&status=eq.active&order=sort_order.asc,created_at.asc`); const j = await r.json(); return Array.isArray(j) ? j : []; }
// Promote the next metro in the chain (lowest sort_order among 'paused') to 'active'. Called when a
// territory exhausts, so discovery flows San Diego → Orange County → LA → ... with no manual step.
async function activateNextTerritory() {
  const r = await sb(`territories?select=id,name&status=eq.paused&order=sort_order.asc,created_at.asc&limit=1`);
  const j = await r.json();
  if (!Array.isArray(j) || !j[0]) { log('  (chain complete — no paused territory left to expand into)'); return null; }
  if (!DRY_RUN) await sb(`territories?id=eq.${j[0].id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'active' }) });
  log(`  ▲ expanding north: activated next territory "${j[0].name}"`);
  return j[0].name;
}
async function patchTerritory(id, patch) { if (DRY_RUN) return; await sb(`territories?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }); }
async function insertLead(row) {
  if (DRY_RUN) return true;
  const r = await sb(`leads?on_conflict=host`, { method: 'POST', headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify(row) });
  return r.ok;
}

// ---------------------------------------------------------------------------- per-territory discovery
async function runTerritory(t, known, budget) {
  const open = await countOpen(t.id);
  const need = MODE === 'fresh' ? t.daily_target : Math.max(0, t.daily_target - open);
  log(`\n▸ ${t.name} [r=${t.radius_km}km, target=${t.daily_target}, open=${open}] → need ${need}${MODE === 'fresh' ? ' (fresh mode)' : ''}`);
  if (need <= 0) { await patchTerritory(t.id, { last_run_at: new Date().toISOString() }); return { inserted: 0, freshCandidates: 0 }; }
  if (DRY_RUN) { log(`  [DRY] would discover up to ${need} across [${(t.industries || ['legal']).join(', ')}] — no Places calls, no writes.`); return { inserted: 0, freshCandidates: 0 }; }

  let inserted = 0, freshCandidates = 0;
  const industries = (t.industries && t.industries.length) ? t.industries : ['legal'];
  for (const industry of industries) {
    if (inserted >= need || budget.details <= 0) break;
    const query = `${INDUSTRY_QUERY[industry] || INDUSTRY_QUERY.other}${t.region_label ? ` in ${t.region_label}` : ''}`;
    let pageToken = null;
    for (let page = 0; page < 3 && inserted < need && budget.details > 0; page++) {
      let res;
      try { res = await textSearchPage(query, t.anchor_lat, t.anchor_lng, Number(t.radius_km) * 1000, pageToken); budget.text++; }
      catch (e) { log(`  ! ${industry} text search failed: ${e.message}`); break; }
      for (const r of res.results) {
        if (inserted >= need || budget.details <= 0) break;
        if (isRepairShop(r.name, r.types)) continue;
        if (r.place_id && known.placeIds.has(r.place_id)) continue;   // known shop — costs no Details call
        freshCandidates++;
        if (r.place_id) known.placeIds.add(r.place_id);               // avoid re-processing within the run
        // Spend ONE Place Details call to get the website.
        budget.details--;
        const d = await placeDetails(r.place_id); await sleep(120);
        const website = d.website || ''; const host = hostOf(website);
        if (!website || !host) continue;
        if (known.hosts.has(host)) continue;                          // domain already a lead (unique host)
        known.hosts.add(host);
        const emails = await enrichEmail(website);
        const qual = await qualify(website);
        if (!isContactable(qual.scores)) { log(`  · ${r.name} (${host}) already scores well — skipped`); continue; }
        const pain = painScore(qual.scores, industry);
        const hook = leadHook(qual.scores, industry);
        const mail = buildEmail(r.name, host, qual.scores, industry);
        const ok = await insertLead({
          territory_id: t.id, owner_id: t.owner_id || null, business_name: r.name, website, host,
          place_id: r.place_id, city: t.region_label || null, state: null, phone: d.formatted_phone_number || null,
          email: emails[0] || null, emails, industry, scores: qual.scores, pain, hook,
          failing_audits: qual.failing_audits, security_headers: qual.security_headers,
          email_subject: mail.subject, email_draft: mail.body, status: 'new',
        });
        if (ok) { inserted++; log(`  + ${r.name} (${host}) pain ${pain} [sec ${qual.scores.security} seo ${qual.scores.seo} perf ${qual.scores.performance}]${emails[0] ? ' ✉' : ''}`); }
      }
      pageToken = res.nextPageToken; if (!pageToken) break;
      await sleep(2000);   // Places requires a delay before a page token activates.
    }
  }

  // Radius ring: under-filled means the current ring is mining out. Widen it for next time, or retire
  // the territory once we are at max radius and still finding nothing new.
  const patch = { last_run_at: new Date().toISOString() };
  let exhausted = false;
  if (inserted < need) {
    const r = Number(t.radius_km), step = Number(t.radius_step_km), max = Number(t.max_radius_km);
    if (r < max) { patch.radius_km = Math.min(max, r + step); log(`  ↔ ring widening ${r}→${patch.radius_km}km (under-filled ${inserted}/${need})`); }
    else if (freshCandidates === 0) { patch.status = 'exhausted'; exhausted = true; log(`  ⊘ ${t.name} exhausted (max radius, no new shops)`); }
  }
  await patchTerritory(t.id, patch);
  if (exhausted) await activateNextTerritory();   // metro mined out → expand to the next one north
  return { inserted, freshCandidates };
}

// ---------------------------------------------------------------------------- main
async function main() {
  const territories = await loadTerritories();
  if (!territories.length) { log('No active territories — nothing to discover.'); return; }
  const known = await loadKnown();
  const needSum = territories.reduce((s, t) => s + Math.max(0, t.daily_target), 0);
  const cap = Math.min(HARD_DETAILS_CEILING, Number.isFinite(CAP_OVERRIDE) && CAP_OVERRIDE > 0 ? CAP_OVERRIDE : needSum || 40);
  const budget = { details: cap, text: 0 };
  log(`${DRY_RUN ? '[DRY] ' : ''}Droptimize discovery: ${territories.length} active territory(ies), ${known.hosts.size} known leads, Place-Details cap ${cap} this run (mode=${MODE}).`);

  let totalInserted = 0;
  for (const t of territories) {
    if (budget.details <= 0) { log(`\n(budget cap reached — ${territories.indexOf(t)} territory(ies) left for next run)`); break; }
    const { inserted } = await runTerritory(t, known, budget);
    totalInserted += inserted;
  }
  const detailsUsed = cap - budget.details;
  log(`\n${DRY_RUN ? '[DRY] ' : ''}Done: ${totalInserted} new lead(s). Google Places spent this run: ${budget.text} Text Search + ${detailsUsed} Place Details = ${budget.text + detailsUsed} billable calls.`);
}

main().catch((e) => { console.error('✗', e.stack || e.message || e); process.exit(1); });
