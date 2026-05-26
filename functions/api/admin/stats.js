async function fetchStripeData(env) {
  if (!env.STRIPE_SECRET_KEY) return null;
  const auth = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  const base = 'https://api.stripe.com/v1';
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

  try {
    const [sessRes, subsRes, pastDueRes, cancelledRes] = await Promise.all([
      fetch(`${base}/checkout/sessions?limit=20&status=complete&created[gte]=${thirtyDaysAgo}`, { headers: auth }),
      fetch(`${base}/subscriptions?status=active&limit=100`, { headers: auth }),
      fetch(`${base}/subscriptions?status=past_due&limit=20`, { headers: auth }),
      fetch(`${base}/subscriptions?status=canceled&created[gte]=${thirtyDaysAgo}&limit=20`, { headers: auth }),
    ]);
    const [sessData, subsData, pastDueData, cancelledData] = await Promise.all([sessRes.json(), subsRes.json(), pastDueRes.json(), cancelledRes.json()]);

    const recentOrders = (sessData.data || []).map(s => ({
      email: s.customer_email || s.customer_details?.email || '',
      amount_cents: s.amount_total || 0,
      plan: s.metadata?.plan || '',
      name: s.metadata?.name || '',
      siteUrl: s.metadata?.site_url || '',
      created: new Date(s.created * 1000).toISOString(),
    }));

    const revenue_30d_cents = recentOrders.reduce((t, o) => t + (o.amount_cents || 0), 0);

    let mrr_cents = 0;
    const activeSubs = subsData.data || [];
    for (const s of activeSubs) {
      for (const item of (s.items?.data || [])) {
        const p = item.price;
        if (!p?.recurring) continue;
        const amt = (p.unit_amount || 0) * (item.quantity || 1);
        const { interval, interval_count = 1 } = p.recurring;
        if (interval === 'month') mrr_cents += amt / interval_count;
        else if (interval === 'year') mrr_cents += amt / (12 * interval_count);
      }
    }

    const failedPayments = (pastDueData.data || []).map(s => ({
      customer: s.customer || '',
      amount_cents: s.items?.data?.[0]?.price?.unit_amount || 0,
      plan: s.metadata?.plan || s.items?.data?.[0]?.price?.nickname || '',
      created: new Date(s.created * 1000).toISOString(),
      current_period_end: new Date(s.current_period_end * 1000).toISOString(),
    }));

    const recentCancelled = (cancelledData.data || []).map(s => ({
      customer: s.customer || '',
      plan: s.metadata?.plan || s.items?.data?.[0]?.price?.nickname || '',
      cancelled_at: new Date(((s.canceled_at || s.ended_at) || s.created) * 1000).toISOString(),
    }));

    return { mrr_cents: Math.round(mrr_cents), active_subs: activeSubs.length, revenue_30d_cents, recentOrders, failedPayments, recentCancelled };
  } catch (e) {
    return { error: e.message };
  }
}

export async function onRequestGet({ request, env }) {
  const secret = request.headers.get('X-Admin-Secret');
  if (!secret || secret !== env.ADMIN_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const [submissions, latestAudit, awKeys, stripe] = await Promise.all([
      env.DROPTIMIZE_KV.get('submissions', 'json'),
      env.DROPTIMIZE_KV.get('audit:latest', 'json'),
      env.DROPTIMIZE_KV.list({ prefix: 'auditwatch:' }),
      fetchStripeData(env),
    ]);
    const subs = submissions || [];
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const last7 = subs.filter(s => new Date(s.timestamp).getTime() > weekAgo).length;
    const unread = subs.filter(s => !s.read).length;
    const keys = awKeys.keys || [];
    const plans = { solo: 0, business: 0, agency: 0 };
    await Promise.all(keys.map(async k => {
      const val = await env.DROPTIMIZE_KV.get(k.name, 'json');
      if (val && val.plan) { const p = val.plan.replace('audit-watch-', ''); if (plans[p] !== undefined) plans[p]++; }
    }));
    return new Response(JSON.stringify({
      brand: 'droptimize',
      submissions: { total: subs.length, unread, last7Days: last7, latest: subs[0] || null },
      auditWatch: { totalSubscribers: keys.length, plans },
      latestSeoAudit: latestAudit ? { week: latestAudit.week, scores: latestAudit.scores || {} } : null,
      stripe,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ brand: 'droptimize', error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
