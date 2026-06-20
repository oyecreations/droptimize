// Shared paid-API guard (OYE security baseline, see ~/Desktop/OYE/SECURITY-BASELINE.md).
//
// enforceDailyCap: a GLOBAL per-day ceiling on paid-API calls across ALL IPs. Per-IP
// limits alone don't stop an attacker rotating IPs, so this is the always-on financial
// backstop that bounds the worst-case daily bill no matter how the per-IP limit is
// bypassed. Returns a 429 Response if the cap is hit (caller should `return` it), or
// null to proceed. Increments the counter when it allows the call through.
//
// verifyTurnstile: server-side Turnstile check, ready to wire once a brand ships the
// client widget + TURNSTILE_SECRET. Enforce it where a widget exists (fail closed).
//
// Note: KV is not atomic, so the cap is approximate (bounds damage to ~limit, not exact
// billing) — which is exactly what a cost backstop needs.

export async function enforceDailyCap(kv, brand, { max = 500, env } = {}) {
  const limit = Number(env?.DAILY_SPEND_CAP) || max;
  if (!kv || !limit) return null; // no KV / no limit configured -> don't block
  const day = new Date().toISOString().slice(0, 10);
  const key = `spendcap:${brand}:${day}`;
  const used = Number(await kv.get(key)) || 0;
  if (used >= limit) {
    return new Response(
      JSON.stringify({
        error: "capacity",
        message: "We've reached today's capacity. Please try again tomorrow.",
      }),
      { status: 429, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  }
  await kv.put(key, String(used + 1), { expirationTtl: 172800 }); // 2-day TTL
  return null;
}

export async function verifyTurnstile(token, env, ip) {
  if (!env?.TURNSTILE_SECRET) return false; // no secret configured -> fail closed
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const d = await r.json();
    return d.success === true;
  } catch {
    return false;
  }
}
