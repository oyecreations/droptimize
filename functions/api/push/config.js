// Returns the VAPID public key the browser needs to create a push subscription.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

export async function onRequestGet({ env }) {
  const publicKey = env.DROPTIMIZE_KV ? await env.DROPTIMIZE_KV.get('vapid_public_key') : null;
  return new Response(JSON.stringify({ ok: !!publicKey, publicKey: publicKey || null }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...CORS },
  });
}
