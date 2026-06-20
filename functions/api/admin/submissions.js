// Contact-request management for the operator dashboard.
// Reads/writes the same DROPTIMIZE_KV 'submissions' array that
// /api/submit appends to. Gated by ADMIN_SECRET (same as /api/admin/stats);
// the dashboard proxies these calls and attaches the X-Admin-Secret header.

// Constant-time compare so secret checks don't leak via response timing.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authed(request, env) {
  const secret = request.headers.get('X-Admin-Secret');
  return timingSafeEqual(secret, env.ADMIN_SECRET);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!authed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.DROPTIMIZE_KV) return json({ ok: false, error: 'DROPTIMIZE_KV not bound' }, 500);

  if (request.method === 'PATCH') {
    const { id, read } = await request.json();
    const subs = await env.DROPTIMIZE_KV.get('submissions', 'json') || [];
    const idx = subs.findIndex(function (s) { return s.id === id; });
    if (idx === -1) return json({ ok: false, error: 'Not found' }, 404);
    subs[idx].read = !!read;
    await env.DROPTIMIZE_KV.put('submissions', JSON.stringify(subs));
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json({ ok: false, error: 'Missing id' }, 400);
    let subs = await env.DROPTIMIZE_KV.get('submissions', 'json') || [];
    subs = subs.filter(function (s) { return s.id !== id; });
    await env.DROPTIMIZE_KV.put('submissions', JSON.stringify(subs));
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
