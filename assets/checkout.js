document.querySelectorAll('.checkout-btn').forEach(function(btn) {
  btn.addEventListener('click', async function(e) {
    e.preventDefault();
    var plan = this.dataset.plan;
    var orig = this.textContent;
    this.textContent = 'Loading...';
    this.style.pointerEvents = 'none';
    try {
      var url = (document.getElementById('audit-url') || {}).value || '';
      var name = (document.getElementById('contact-name') || {}).value || '';
      var email = (document.getElementById('contact-email') || {}).value || '';
      var res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan, email: email, url: url, name: name })
      });
      var data = await res.json();
      if (!res.ok || !data.url) throw new Error(data.error || 'Checkout failed');
      window.location.href = data.url;
    } catch(err) {
      alert(err.message || 'Could not start checkout. Please try again.');
      this.textContent = orig;
      this.style.pointerEvents = '';
    }
  });
});

// Audit Watch monthly/annual toggle. Switches the displayed price/note and the
// data-plan each Get Started button posts. CSP-safe: external file, no inline JS.
(function () {
  var grid = document.getElementById('audit-watch-grid');
  var toggle = document.querySelector('.aw-billing-toggle');
  if (!grid || !toggle) return;
  var opts = toggle.querySelectorAll('.aw-bill-opt');

  function styleOpt(b, active) {
    b.style.cssText = 'cursor:pointer;border:none;font:inherit;font-family:"DM Mono",monospace;' +
      'font-size:12px;letter-spacing:0.04em;padding:9px 18px;border-radius:999px;white-space:nowrap;' +
      'transition:background 150ms,color 150ms;' +
      (active ? 'background:var(--gold);color:#0b0b0b;font-weight:600;'
              : 'background:transparent;color:var(--muted);font-weight:400;');
  }

  function apply(bill) {
    var annual = bill === 'annual';
    grid.querySelectorAll('.pricing-card').forEach(function (card) {
      var price = card.querySelector('.pricing-price');
      var note = card.querySelector('.pricing-price-note');
      var cta = card.querySelector('.checkout-btn');
      if (price && price.dataset[bill]) price.textContent = price.dataset[bill];
      if (note && note.dataset[bill + 'Note']) note.textContent = note.dataset[bill + 'Note'];
      var planKey = cta && cta.dataset[annual ? 'planAnnual' : 'planMonthly'];
      if (cta && planKey) cta.dataset.plan = planKey;
    });
    opts.forEach(function (b) { styleOpt(b, b.dataset.bill === bill); });
  }

  opts.forEach(function (b) {
    b.addEventListener('click', function () { apply(this.dataset.bill); });
  });
  apply('monthly');
})();
