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
