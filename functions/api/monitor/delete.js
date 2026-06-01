// Removes one monitor for a device. Requires the device's own push endpoint,
// so a device can only delete its own monitors.
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
  if (!env.DROPTIMIZE_KV) return json({ ok: false, error: 'misconfigured' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400);
  }
  if (!body.endpoint || !body.id) return json({ ok: false, error: 'endpoint_and_id_required' }, 400);

  const hash = await sha256b64url(body.endpoint);
  const id = body.id;

  // Verify the monitor belongs to this device before deleting.
  const record = await env.DROPTIMIZE_KV.get(`monitor:${id}`, 'json');
  if (record && record.endpointHash && record.endpointHash !== hash) {
    return json({ ok: false, error: 'not_owner' }, 403);
  }

  await env.DROPTIMIZE_KV.delete(`monitor:${id}`);
  const idxKey = `device:${hash}`;
  const idx = (await env.DROPTIMIZE_KV.get(idxKey, 'json')) || [];
  const next = idx.filter((m) => m.id !== id);
  if (next.length) await env.DROPTIMIZE_KV.put(idxKey, JSON.stringify(next));
  else await env.DROPTIMIZE_KV.delete(idxKey);

  return json({ ok: true });
}
