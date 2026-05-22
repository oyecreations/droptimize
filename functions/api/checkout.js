// POST /api/checkout  { plan, email, url, name }
// Creates a Stripe Checkout session for a Droptimize rebuild package.

export async function onRequestPost({ request, env }) {
  const headers = { "Content-Type": "application/json" };

  try {
    const body = await request.json();
    const { plan, email, url, name } = body;

    const priceMap = {
      single:                env.PRICE_SINGLE,
      standard:              env.PRICE_STANDARD,
      professional:          env.PRICE_PROFESSIONAL,
      "audit-watch-solo":     env.PRICE_AUDIT_WATCH_SOLO,
      "audit-watch-business": env.PRICE_AUDIT_WATCH_BUSINESS,
      "audit-watch-agency":   env.PRICE_AUDIT_WATCH_AGENCY,
    };

    const priceId = priceMap[plan];
    if (!priceId) {
      return new Response(JSON.stringify({ error: "invalid plan" }), { status: 400, headers });
    }

    const subscriptionPlans = ["audit-watch-solo", "audit-watch-business", "audit-watch-agency"];
    const mode = subscriptionPlans.includes(plan) ? "subscription" : "payment";

    const params = new URLSearchParams();
    params.set("mode", mode);
    params.set("line_items[0][price]", priceId);
    params.set("line_items[0][quantity]", "1");
    params.set("cancel_url", "https://droptimize.org/#pricing");
    params.set("metadata[plan]", plan);
    params.set("metadata[site_url]", url || "");
    params.set("metadata[name]", name || "");
    params.set("success_url", `https://droptimize.org/success?plan=${plan}&session_id={CHECKOUT_SESSION_ID}`);
    if (email && email.includes("@")) {
      params.set("customer_email", email);
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      return new Response(
        JSON.stringify({ error: session.error?.message || "stripe_error" }),
        { status: 502, headers }
      );
    }

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
