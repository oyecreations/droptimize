// POST /api/webhook — Stripe webhook handler for Droptimize

async function verifyStripeSignature(request, secret) {
  const body = await request.text();
  const sigHeader = request.headers.get("stripe-signature") || "";
  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return null;

  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return null;

  const signed = `${ts}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === v1 ? body : null;
}

const planLabels = {
  single:                "Single Site — $199",
  standard:              "Standard — $799",
  professional:          "Professional — $1,299",
  "audit-watch-solo":     "Audit Watch Solo (subscription)",
  "audit-watch-business": "Audit Watch Business (subscription)",
  "audit-watch-agency":   "Audit Watch Agency (subscription)",
};

export async function onRequestPost({ request, env }) {
  const body = await verifyStripeSignature(request.clone(), env.STRIPE_WEBHOOK_SECRET);
  if (!body) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(body);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const plan    = session.metadata?.plan || "unknown";
    const siteUrl = session.metadata?.site_url || "";
    const name    = session.metadata?.name || "";
    const email   = session.customer_email || session.customer_details?.email || "";
    const amount  = session.amount_total ? `$${(session.amount_total / 100).toFixed(2)}` : "";
    const label   = planLabels[plan] || plan;

    if (env.RESEND_API_KEY) {
      const lines = [
        `<strong>Plan:</strong> ${label}`,
        amount  ? `<strong>Amount:</strong> ${amount}` : "",
        name    ? `<strong>Name:</strong> ${name}` : "",
        email   ? `<strong>Email:</strong> ${email}` : "",
        siteUrl ? `<strong>Site URL:</strong> ${siteUrl}` : "",
        `<strong>Session:</strong> ${session.id}`,
      ].filter(Boolean).join("<br>");

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Droptimize <hello@droptimize.org>",
          to: ["lessthanblake@proton.me"],
          subject: `New Droptimize booking — ${label}`,
          html: `<p>${lines}</p>`,
        }),
      });
    }
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const sub   = event.data.object;
    const email = sub.metadata?.email || "";
    const plan  = sub.metadata?.plan || "";
    if (email && env.DROPTIMIZE_KV) {
      await env.DROPTIMIZE_KV.put(`auditwatch:${email}`, JSON.stringify({
        plan, status: sub.status, subscriptionId: sub.id, updated: new Date().toISOString()
      }));
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub   = event.data.object;
    const email = sub.metadata?.email || "";
    if (email && env.DROPTIMIZE_KV) {
      await env.DROPTIMIZE_KV.delete(`auditwatch:${email}`);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
