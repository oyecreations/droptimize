import { enforceDailyCap } from './_lib/spend-guard.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// Block SSRF to internal/metadata targets. Workers can't resolve DNS, so reject
// private/loopback/link-local IP literals + non-public hostnames; require http(s).
function isSafePublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || host === 'metadata.google.internal') return false;
  if (host.includes(':')) return !(host === '::1' || host === '::' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd'));
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return ![/^127\./,/^10\./,/^192\.168\./,/^169\.254\./,/^172\.(1[6-9]|2\d|3[01])\./,/^0\./,/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./].some(re => re.test(host));
  }
  return true;
}

async function runPSI(url, apiKey) {
  const cats = 'category=SEO&category=PERFORMANCE&category=BEST_PRACTICES&category=ACCESSIBILITY';
  const key  = apiKey ? `&key=${apiKey}` : '';
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&${cats}${key}`;
  const res = await fetch(endpoint);
  if (!res.ok) return null;
  const data = await res.json();
  const c = data?.lighthouseResult?.categories || {};
  return {
    seo:           Math.round((c.seo?.score           || 0) * 100),
    performance:   Math.round((c.performance?.score   || 0) * 100),
    best_practices: Math.round((c['best-practices']?.score || 0) * 100),
    accessibility: Math.round((c.accessibility?.score || 0) * 100),
  };
}

async function checkSecurity(url) {
  const res = await fetch(url, { method: 'HEAD' });
  const h   = Object.fromEntries(res.headers.entries());
  const checks = [
    !!h['strict-transport-security'],
    !!h['content-security-policy'],
    !!h['x-content-type-options'],
    !!h['x-frame-options'],
    !!h['referrer-policy'],
    !!h['permissions-policy'],
  ];
  return Math.round(checks.filter(Boolean).length * 100 / checks.length);
}

// Sensitive-file / information-disclosure check. Probes common repo + config
// paths that should never be public. A Lighthouse/header audit never requests
// these, so this catches a class headers alone miss.
async function checkExposure(url) {
  let origin;
  try { origin = new URL(url).origin; } catch (e) { return []; }
  const PATHS = [
    '/.git/config', '/.git/HEAD', '/.env', '/wrangler.toml', '/package.json',
    '/package-lock.json', '/CLAUDE.md', '/.DS_Store', '/_private/', '/.npmrc',
  ];
  const found = [];
  await Promise.all(PATHS.map(async (p) => {
    try {
      const r = await fetch(origin + p, { method: 'GET', headers: { 'cache-control': 'no-cache' }, redirect: 'manual' });
      if (!r.ok) return;
      const body = (await r.text()).slice(0, 2000);
      const looksHtml = /<!doctype html|<html/i.test(body.slice(0, 300));
      const tell = /\[core\]|^ref:\s|namespace_id|pages_build_output|"dependencies"|"scripts"\s*:|-----BEGIN |registry\s*=|_auth\s*=/im.test(body);
      // A real config/secret/source file is either non-HTML with content, or carries a tell-tale token.
      if ((!looksHtml && body.trim().length > 0) || tell) found.push(p);
    } catch (e) {}
  }));
  return found;
}

function scoreHex(n) {
  if (n == null) return '#8C8C8C';
  return n >= 90 ? '#C9A84C' : n >= 70 ? '#F59E0B' : '#E05A3A';
}

function buildCustomerEmail(name, url, scores) {
  const cats = [
    { key: 'seo', label: 'SEO' },
    { key: 'security', label: 'Security' },
    { key: 'performance', label: 'Performance' },
    { key: 'accessibility', label: 'Accessibility' },
    { key: 'best_practices', label: 'Best Practices' },
  ];

  const rows = cats.map(c => {
    const v     = scores[c.key];
    const color = scoreHex(v);
    const val   = v != null ? `${v}%` : 'N/A';
    return `<tr>
      <td style="padding:10px 16px;font-family:monospace;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#8C8C8C;border-bottom:1px solid #2E2E2E;">${c.label}</td>
      <td style="padding:10px 16px;font-family:monospace;font-size:20px;font-weight:700;color:${color};text-align:right;border-bottom:1px solid #2E2E2E;">${val}</td>
    </tr>`;
  }).join('');

  const firstName = name.split(' ')[0];

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#111111;font-family:Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:48px 24px;">
    <p style="font-family:monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#C9A84C;margin:0 0 32px;">droptimize.org</p>
    <h1 style="font-size:28px;font-weight:900;color:#F5F3EE;margin:0 0 10px;line-height:1.2;">Your audit is in: ${firstName}.</h1>
    <p style="color:#8C8C8C;font-size:15px;margin:0 0 32px;line-height:1.6;">Here's how <strong style="color:#EBEBEB;">${url}</strong> scored across all five categories.</p>
    <table style="width:100%;border-collapse:collapse;background:#1B1B1B;margin-bottom:32px;">
      ${rows}
    </table>
    <p style="color:#8C8C8C;font-size:14px;line-height:1.7;margin:0 0 20px;">Here's why those numbers matter right now: companies are already wiring AI into how they vet who they work with, and that AI reads the same signals you see above. Weak security, slow load times, and accessibility gaps get a site quietly filtered out before a human ever sees it. The AI isn't wrong to do it. Those are real flaws, and they're costing you introductions you'll never know you lost.</p>
    <p style="color:#8C8C8C;font-size:14px;line-height:1.7;margin:0 0 28px;">We'll follow up shortly with a full breakdown - what's pulling each score down and exactly what it would take to hit 100% across the board. And when you rebuild with us, 10% of the project goes to a 501(c)(3) you choose, so the fix funds something that matters.</p>
    <a href="https://droptimize.org/#pricing" style="display:inline-block;background:#C9A84C;color:#111111;font-family:monospace;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;padding:13px 28px;text-decoration:none;font-weight:700;">See rebuild packages &rarr;</a>
    <p style="color:#3A3A3A;font-size:11px;margin-top:48px;line-height:1.6;">droptimize.org &nbsp;&middot;&nbsp; by OYE Creations LLC<br>10% of every project donated to a 501(c)(3) of your choice.</p>
  </div>
</body>
</html>`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const formData = await request.formData();

    if (formData.get('_honey')) return json({ ok: true });

    const name    = (formData.get('name')    || '').trim();
    const email   = (formData.get('email')   || '').trim();
    const website = (formData.get('website') || '').trim();
    const charity = (formData.get('charity') || '').trim();
    const message = (formData.get('message') || '').trim();

    if (!name || !email) return json({ ok: false, error: 'Missing required fields' }, 400);

    // Global per-day spend cap: bounds total PSI quota + outbound fetch/email spend
    // across all IPs (this endpoint is unauthenticated and calls paid PSI + Resend).
    const capped = await enforceDailyCap(env.DROPTIMIZE_KV, 'droptimize-submit', { max: 300, env });
    if (capped) return json({ ok: false, error: "We've reached today's capacity. Please try again tomorrow." }, 429);

    // Run audit concurrently with 25s timeout. A website that fails the SSRF
    // check is treated as no website: skip all fetch/PSI work, keep the rest of
    // the submission/email flow intact.
    let scores = null;
    if (website && isSafePublicUrl(website)) {
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), 25000));
      const audit   = Promise.all([
        runPSI(website, env.PSI_KEY).catch(() => null),
        checkSecurity(website).catch(() => null),
        checkExposure(website).catch(() => []),
      ]).then(([psi, sec, exposed]) => {
        if (!psi) return null;
        let security = sec;
        // Each exposed sensitive file drops the Security score; floor at 0.
        if (exposed && exposed.length && security != null) security = Math.max(0, security - exposed.length * 15);
        return { ...psi, security, exposed: exposed || [] };
      });

      scores = await Promise.race([audit, timeout]);
    }

    const submission = {
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      name, email, website, charity, message,
      subject:   (formData.get('_subject') || 'droptimize.org - Audit Request').trim(),
      source:    (formData.get('_source')  || 'droptimize').trim(),
      scores,
      read: false,
    };

    if (env.DROPTIMIZE_KV) {
      const existing = await env.DROPTIMIZE_KV.get('submissions', 'json') || [];
      existing.unshift(submission);
      await env.DROPTIMIZE_KV.put('submissions', JSON.stringify(existing.slice(0, 1000)));
    }

    if (env.RESEND_API_KEY) {
      const scoreLines = scores ? [
        '',
        'Scores:',
        `  SEO:            ${scores.seo}%`,
        `  Security:       ${scores.security != null ? scores.security + '%' : 'N/A'}`,
        `  Performance:    ${scores.performance}%`,
        `  Accessibility:  ${scores.accessibility}%`,
        `  Best Practices: ${scores.best_practices}%`,
        ...(scores.exposed && scores.exposed.length ? ['', `  EXPOSED FILES (${scores.exposed.length}): ${scores.exposed.join(', ')}`] : []),
      ] : ['', '(No URL provided - no scores run)'];

      const ownerText = [
        `Name:    ${name}`,
        `Email:   ${email}`,
        website ? `Website: ${website}` : '',
        charity ? `Charity: ${charity}` : '',
        ...scoreLines,
        '',
        'Message:',
        message || '(none)',
        '',
        '---',
        `Source: ${submission.source}`,
        `Time:   ${submission.timestamp}`,
      ].filter(l => l !== undefined).join('\n');

      const emails = [
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    'Droptimize <forms@mail.oyecreations.com>',
            to:      ['oyecreations@proton.me'],
            subject: scores ? `Droptimize - Audit request + scores - ${website}` : `Droptimize - Audit request - ${name}`,
            text:    ownerText,
          }),
        }),
      ];

      if (scores && email) {
        emails.push(
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:    'Droptimize <hello@mail.oyecreations.com>',
              to:      [email],
              reply_to: 'oyecreations@proton.me',
              subject: `Your audit results - ${website}`,
              html:    buildCustomerEmail(name, website, scores),
            }),
          })
        );
      }

      await Promise.all(emails);
    }

    return json({ ok: true, scores });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
