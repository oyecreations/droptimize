// droptimize-monitor
// Daily Cron Worker. Walks every per-device monitor in KV, runs the audit at
// the device's chosen cadence, diffs the result against the last one, and
// fires a (payload-less) web push when a threshold is crossed. Shares the
// DROPTIMIZE_KV namespace with the Pages site.

const CAT_KEYS = ["seo", "performance", "best_practices", "accessibility", "security"];
const CAT_LABEL = {
  seo: "SEO",
  performance: "Performance",
  best_practices: "Best Practices",
  accessibility: "Accessibility",
  security: "Security",
};
const HEADER_MAP = {
  hsts: { name: "strict-transport-security", label: "HSTS" },
  csp: { name: "content-security-policy", label: "Content Security Policy" },
  xcto: { name: "x-content-type-options", label: "X-Content-Type-Options" },
  xfo: { name: "x-frame-options", label: "X-Frame-Options" },
  rp: { name: "referrer-policy", label: "Referrer-Policy" },
  pp: { name: "permissions-policy", label: "Permissions-Policy" },
};
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

const DUE_MS = { daily: 20 * 3600e3, weekly: 6.5 * 24 * 3600e3, monthly: 27 * 24 * 3600e3 };

// ---------- base64url ----------
function b64url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256b64url(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return b64url(new Uint8Array(buf));
}

// ---------- VAPID web push (no payload) ----------
async function importVapidKey(jwkStr) {
  const jwk = JSON.parse(jwkStr);
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function vapidAuthHeader(endpoint, env, privKey) {
  const aud = new URL(endpoint).origin;
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    new TextEncoder().encode(
      JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })
    )
  );
  const unsigned = header + "." + claims;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privKey,
    new TextEncoder().encode(unsigned)
  );
  const jwt = unsigned + "." + b64url(new Uint8Array(sig));
  return "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY;
}
// Returns the HTTP status (201 = delivered, 404/410 = subscription gone).
async function sendPush(endpoint, env, privKey) {
  const auth = await vapidAuthHeader(endpoint, env, privKey);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: auth, TTL: "86400", "Content-Length": "0", Urgency: "normal" },
  });
  return res.status;
}

// ---------- audit ----------
async function runPsi(url, psiKey) {
  const api =
    "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=" +
    encodeURIComponent(url) +
    "&strategy=mobile&category=SEO&category=PERFORMANCE&category=BEST_PRACTICES&category=ACCESSIBILITY" +
    (psiKey ? "&key=" + psiKey : "");
  try {
    const res = await fetch(api);
    if (!res.ok) return null;
    const data = await res.json();
    const cats = data?.lighthouseResult?.categories;
    if (!cats) return null;
    const score = (k) => (cats[k] && cats[k].score != null ? Math.round(cats[k].score * 100) : null);
    const seo = score("seo"),
      perf = score("performance"),
      bp = score("best-practices"),
      acc = score("accessibility");
    if (seo == null && perf == null && bp == null && acc == null) return null;
    return { seo, performance: perf, best_practices: bp, accessibility: acc };
  } catch (e) {
    return null;
  }
}
async function checkSiteAndHeaders(url) {
  // Returns { down, checks, securityScore }.
  let down = false;
  let resp = null;
  try {
    resp = await fetch(url, { method: "GET", redirect: "follow", headers: { "User-Agent": UA } });
    if (resp.status >= 500) down = true;
  } catch (e) {
    down = true;
  }
  const checks = {};
  let pass = 0;
  for (const k of Object.keys(HEADER_MAP)) {
    const has = resp ? resp.headers.get(HEADER_MAP[k].name) != null : false;
    checks[k] = has;
    if (has) pass++;
  }
  const securityScore = Math.round((pass * 100) / 6);
  return { down, checks, securityScore };
}

// ---------- diff -> alert lines ----------
function buildAlertLines(rec, scores, checks, down) {
  const lines = [];
  const first = !rec.lastScores;

  if (down) {
    if (rec.alertOnDown && !rec.lastDown) lines.push(rec.domain + " is not responding");
    return lines; // scores unreliable when down
  }
  if (rec.lastDown && rec.alertOnDown) lines.push(rec.domain + " is back online");

  for (const k of CAT_KEYS) {
    const cur = scores[k];
    if (cur == null) continue;
    const prev = rec.lastScores ? rec.lastScores[k] : null;
    if (rec.alertOnDrop && prev != null && cur < prev) {
      lines.push(CAT_LABEL[k] + " " + prev + " to " + cur);
    } else if (cur < rec.minScore && (first || (prev != null && prev >= rec.minScore))) {
      lines.push(CAT_LABEL[k] + " " + cur + ", under your " + rec.minScore + " floor");
    }
  }

  if (rec.lastChecks) {
    for (const k of Object.keys(HEADER_MAP)) {
      if (rec.lastChecks[k] === true && checks[k] === false) {
        lines.push(HEADER_MAP[k].label + " header missing");
      }
    }
  }
  return lines;
}

function isDue(rec, now) {
  if (!rec.lastRunAt) return true;
  const elapsed = now - new Date(rec.lastRunAt).getTime();
  return elapsed >= (DUE_MS[rec.frequency] || DUE_MS.weekly);
}

// ---------- core ----------
async function processAll(env, opts) {
  opts = opts || {};
  const privKey = await importVapidKey(env.VAPID_PRIVATE_JWK);
  const now = Date.now();
  const summary = { scanned: 0, due: 0, alerted: 0, removed: 0, errors: 0 };

  let cursor;
  do {
    const list = await env.DROPTIMIZE_KV.list({ prefix: "monitor:", cursor });
    cursor = list.list_complete ? null : list.cursor;
    for (const key of list.keys) {
      summary.scanned++;
      let rec;
      try {
        rec = await env.DROPTIMIZE_KV.get(key.name, "json");
      } catch (e) {
        summary.errors++;
        continue;
      }
      if (!rec || rec.paused) continue;
      if (!opts.force && !isDue(rec, now)) continue;
      summary.due++;

      try {
        const site = await checkSiteAndHeaders(rec.url);
        let scores = null;
        if (!site.down) {
          const psi = await runPsi(rec.url, env.PSI_KEY);
          if (psi) {
            scores = { ...psi, security: site.securityScore };
          }
        }

        const lines = buildAlertLines(rec, scores || {}, site.checks, site.down);

        if (lines.length) {
          const alert = {
            title: rec.domain,
            body: lines.join(" · "),
            url: rec.url,
            tag: rec.domain,
            ts: new Date(now).toISOString(),
          };
          const pendKey = "pending:" + rec.endpointHash;
          const pend = (await env.DROPTIMIZE_KV.get(pendKey, "json")) || [];
          pend.push(alert);
          await env.DROPTIMIZE_KV.put(pendKey, JSON.stringify(pend.slice(-20)));

          try {
            const status = await sendPush(rec.subscription.endpoint, env, privKey);
            if (status === 404 || status === 410) {
              await removeMonitor(env, rec);
              summary.removed++;
              continue;
            }
            summary.alerted++;
          } catch (e) {
            summary.errors++;
          }
        }

        // Persist this run's state.
        rec.lastRunAt = new Date(now).toISOString();
        if (scores) rec.lastScores = scores;
        rec.lastChecks = site.checks;
        rec.lastDown = site.down;
        await env.DROPTIMIZE_KV.put(key.name, JSON.stringify(rec));
      } catch (e) {
        summary.errors++;
      }
    }
  } while (cursor);

  return summary;
}

async function removeMonitor(env, rec) {
  await env.DROPTIMIZE_KV.delete("monitor:" + rec.id);
  const idxKey = "device:" + rec.endpointHash;
  const idx = (await env.DROPTIMIZE_KV.get(idxKey, "json")) || [];
  const next = idx.filter((m) => m.id !== rec.id);
  if (next.length) await env.DROPTIMIZE_KV.put(idxKey, JSON.stringify(next));
  else await env.DROPTIMIZE_KV.delete(idxKey);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processAll(env, {}));
  },

  // Manual trigger for testing: GET /run?key=<MANUAL_SECRET>[&force=1]
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/run") {
      if (!env.MANUAL_SECRET || url.searchParams.get("key") !== env.MANUAL_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const summary = await processAll(env, { force: url.searchParams.get("force") === "1" });
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("droptimize-monitor", { status: 200 });
  },
};
