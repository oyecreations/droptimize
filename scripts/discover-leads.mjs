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
// Uses the NEW Places API (places.googleapis.com searchText) like SureScout — the legacy Places API
// is NOT enabled on this key (verified 2026-06-22: legacy returns REQUEST_DENIED). searchText returns
// each shop's website INLINE, so one Text Search call yields up to 20 leads with no per-lead lookup.
//   - Only PAID call is Places API (New) Text Search; requesting websiteUri makes it the Enterprise
//     SKU (~1,000 free calls/month, SHARED with SureScout since both use the same key). Each call
//     returns up to 20 places, so daily_target 33 costs only a handful of calls/day.
//   - PSI (audit), header fetch, and email scrape are free / separate quotas.
//   - Dedupe by place_id AND host so a known shop is never re-audited.
//   - Hard per-run cap on Text Search calls (DISCOVER_CAP, default ~ needs/3 + buffer, ceiling 30).
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
const HARD_CALL_CEILING = 30;                                       // absolute backstop on Text Search calls per run (each returns up to 20 places)
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

// One Text Search page on the NEW Places API (places.googleapis.com) — 1 billable Enterprise call that
// returns up to 20 places WITH their website in the response. (The legacy textsearch+details flow is
// gone: the legacy Places API is not enabled on this key, and the New API gives the website inline, so
// there is no separate per-result Place Details call.) locationBias circle keeps it in the ring (50km max).
const SEARCH_FIELDS = 'places.id,places.displayName,places.websiteUri,places.nationalPhoneNumber,places.formattedAddress,places.types,places.businessStatus,nextPageToken';
async function searchTextPage(query, lat, lng, radiusM, pageToken) {
  const body = { textQuery: query };
  if (lat != null && lng != null) body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(Math.round(radiusM), 50000) } };
  if (pageToken) body.pageToken = pageToken;
  let res, data;
  try {
    res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': SEARCH_FIELDS },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (e) { throw new Error(`searchText fetch failed: ${e.message}`); }
  if (!res.ok || data.error) throw new Error(`searchText failed: ${data.error?.status || res.status} ${data.error?.message || ''}`.trim());
  const results = (data.places || []).map((p) => ({
    place_id: p.id, name: p.displayName?.text || '', website: p.websiteUri || '',
    phone: p.nationalPhoneNumber || '', address: p.formattedAddress || '',
    types: p.types || [], businessStatus: p.businessStatus || null,
  }));
  return { results, nextPageToken: data.nextPageToken || null };
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
    if (inserted >= need || budget.calls >= budget.max) break;
    const query = `${INDUSTRY_QUERY[industry] || INDUSTRY_QUERY.other}${t.region_label ? ` in ${t.region_label}` : ''}`;
    let pageToken = null;
    for (let page = 0; page < 3 && inserted < need && budget.calls < budget.max; page++) {
      let res;
      try { res = await searchTextPage(query, t.anchor_lat, t.anchor_lng, Number(t.radius_km) * 1000, pageToken); budget.calls++; }
      catch (e) { log(`  ! ${industry} search failed: ${e.message}`); break; }
      for (const r of res.results) {
        if (inserted >= need) break;
        if (isRepairShop(r.name, r.types)) continue;
        if (r.businessStatus === 'CLOSED_PERMANENTLY') continue;
        if (r.place_id && known.placeIds.has(r.place_id)) continue;   // already a lead
        if (r.place_id) known.placeIds.add(r.place_id);               // a new shop in the ring
        freshCandidates++;
        const website = r.website || ''; const host = hostOf(website);
        if (!website || !host) continue;                              // no site listed → nothing to audit
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
          place_id: r.place_id, city: t.region_label || null, state: null, phone: r.phone || null,
          email: emails[0] || null, emails, industry, scores: qual.scores, pain, hook,
          failing_audits: qual.failing_audits, security_headers: qual.security_headers,
          email_subject: mail.subject, email_draft: mail.body, status: 'new',
        });
        if (ok) { inserted++; log(`  + ${r.name} (${host}) pain ${pain} [sec ${qual.scores.security} seo ${qual.scores.seo} perf ${qual.scores.performance}]${emails[0] ? ' ✉' : ''}`); }
      }
      pageToken = res.nextPageToken; if (!pageToken) break;
      await sleep(1500);   // brief pause before requesting the next page token
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
  const maxCalls = Math.min(HARD_CALL_CEILING, Number.isFinite(CAP_OVERRIDE) && CAP_OVERRIDE > 0 ? CAP_OVERRIDE : Math.max(12, Math.ceil((needSum || 33) / 3) + 4));
  const budget = { calls: 0, max: maxCalls };
  log(`${DRY_RUN ? '[DRY] ' : ''}Droptimize discovery: ${territories.length} active territory(ies), ${known.hosts.size} known leads, Text-Search-call cap ${maxCalls} this run (mode=${MODE}).`);

  let totalInserted = 0;
  for (const t of territories) {
    if (budget.calls >= budget.max) { log(`\n(call cap reached — ${territories.length - territories.indexOf(t)} territory(ies) left for next run)`); break; }
    const { inserted } = await runTerritory(t, known, budget);
    totalInserted += inserted;
  }
  log(`\n${DRY_RUN ? '[DRY] ' : ''}Done: ${totalInserted} new lead(s). Places API (New) spent this run: ${budget.calls} Text Search call(s) (each returns up to 20 places, website inline).`);
}

main().catch((e) => { console.error('✗', e.stack || e.message || e); process.exit(1); });
