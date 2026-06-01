// Lists the monitors belonging to one device (by its push endpoint), so the
// Watch page can show and manage what this browser is tracking.
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
  if (!env.DROPTIMIZE_KV) return json({ ok: true, monitors: [] });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (!body.endpoint) return json({ ok: false, error: 'endpoint_required' }, 400);
  const hash = await sha256b64url(body.endpoint);
  const monitors = (await env.DROPTIMIZE_KV.get(`device:${hash}`, 'json')) || [];
  return json({ ok: true, monitors });
}
