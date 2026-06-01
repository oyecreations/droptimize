// Drains queued alerts for one device. Called by the service worker after it
// receives a (payload-less) push: it sends its own endpoint, gets the alert
// detail, and the queue is cleared. Keeps alert content off the push wire.
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

export async function onRequestPost({ request, env }) {
  if (!env.DROPTIMIZE_KV) return json({ ok: true, alerts: [] });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (!body.endpoint) return json({ ok: false, error: 'endpoint_required' }, 400);

  const hash = await sha256b64url(body.endpoint);
  const key = `pending:${hash}`;
  const alerts = (await env.DROPTIMIZE_KV.get(key, 'json')) || [];
  if (alerts.length) await env.DROPTIMIZE_KV.delete(key);
  return json({ ok: true, alerts });
}
