// Creates (or updates) a monitor for one device: a site URL + cadence + alert
// thresholds, tied to this browser's push subscription. Anonymous self-serve;
// preferences live on the device that subscribed, no login.
import { enforceDailyCap } from '../_lib/spend-guard.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

async function sha256b64url(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  let bin = '';
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const FREQS = ['daily', 'weekly', 'monthly'];

export async function onRequestPost({ request, env }) {
  if (!env.DROPTIMIZE_KV) return json({ ok: false, error: 'misconfigured' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }

  const sub = body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json({ ok: false, error: 'invalid_subscription' }, 400);
  }

  // Validate + normalize the site URL.
  let parsed;
  try {
    parsed = new URL(String(body.url || '').trim());
  } catch {
    return json({ ok: false, error: 'invalid_url' }, 400);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return json({ ok: false, error: 'invalid_protocol' }, 400);
  }
  const url = parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
  const domain = parsed.hostname.replace(/^www\./, '');

  const frequency = FREQS.includes(body.frequency) ? body.frequency : 'weekly';
  let minScore = parseInt(body.minScore, 10);
  if (!Number.isFinite(minScore)) minScore = 90;
  minScore = Math.max(0, Math.min(100, minScore));
  const alertOnDrop = body.alertOnDrop !== false;
  const alertOnDown = body.alertOnDown !== false;

  const endpointHash = await sha256b64url(sub.endpoint);
  const id = await sha256b64url(sub.endpoint + '|' + url);

  // Per-device cap: a device is the push endpoint (endpointHash). The existing
  // `device:<endpointHash>` index already lists this device's monitors, so we
  // count it directly (no extra counter key needed). Creating a *new* monitor
  // is rejected once a device is at the limit; updating one it already has is
  // always allowed (the id is already in the index, so it never trips the cap).
  const MAX_PER_DEVICE = 25;
  const deviceIdxKey = `device:${endpointHash}`;
  const deviceIdx = (await env.DROPTIMIZE_KV.get(deviceIdxKey, 'json')) || [];
  const isUpdate = deviceIdx.some((m) => m.id === id);
  if (!isUpdate && deviceIdx.length >= MAX_PER_DEVICE) {
    return json(
      { ok: false, error: 'too_many_monitors', message: `This device already has the maximum of ${MAX_PER_DEVICE} monitors.` },
      429
    );
  }

  // Global per-day spend backstop: the daily cron runs paid PSI + fetches for
  // every stored monitor, so cap how many monitors can be created per day across
  // all devices/IPs. enforceDailyCap returns a 429 Response when the cap is hit.
  const capped = await enforceDailyCap(env.DROPTIMIZE_KV, 'droptimize-monitor-create', { max: 200, env });
  if (capped) {
    return json(
      { ok: false, error: 'capacity', message: "We've reached today's capacity. Please try again tomorrow." },
      429
    );
  }

  const existing = await env.DROPTIMIZE_KV.get(`monitor:${id}`, 'json');
  const record = {
    id,
    url,
    domain,
    frequency,
    minScore,
    alertOnDrop,
    alertOnDown,
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    endpointHash,
    paused: false,
    createdAt: existing?.createdAt || new Date().toISOString(),
    lastRunAt: existing?.lastRunAt || null,
    lastScores: existing?.lastScores || null,
    lastChecks: existing?.lastChecks || null,
    lastDown: existing?.lastDown || false,
  };
  await env.DROPTIMIZE_KV.put(`monitor:${id}`, JSON.stringify(record));

  // Maintain a per-device index so the UI can list/manage this device's monitors.
  // Reuse deviceIdx/deviceIdxKey already read above for the per-device cap check.
  const summary = { id, url, domain, frequency, minScore, alertOnDrop, alertOnDown };
  const next = deviceIdx.filter((m) => m.id !== id);
  next.push(summary);
  await env.DROPTIMIZE_KV.put(deviceIdxKey, JSON.stringify(next));

  return json({ ok: true, id, monitor: summary });
}
