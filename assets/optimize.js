// Load audit report
(function() {
  var SCORE_ORDER = ['seo', 'security', 'performance', 'accessibility', 'best_practices'];
  var SCORE_LABEL = {
    seo: 'SEO',
    security: 'Security',
    performance: 'Performance',
    accessibility: 'Accessibility',
    best_practices: 'Best Practices'
  };

  function colorClass(n) {
    return n >= 90 ? 'pv-gold' : n >= 70 ? 'pv-amber' : 'pv-red';
  }

  function fallbackEntry() {
    return '<div class="pt-entry" style="padding-top:20px;">' +
      '<div class="pt-header"><div>' +
        '<a href="https://droptimize.org" target="_blank" rel="noopener" class="pt-domain">droptimize.org <span class="p-arrow">↗</span></a>' +
        '<span class="pt-biz">Droptimize - by OYE Creations</span>' +
      '</div></div>' +
      '<p style="font-family:\'DM Mono\',monospace;font-size:12px;letter-spacing:0.06em;color:var(--muted);">Audit runs every Monday automatically.</p>' +
    '</div>';
  }

  fetch('/api/audit/latest')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var list = document.getElementById('live-audit-list');
      if (!list) return;
      var audit = data.audit;
      if (!audit) { list.innerHTML = fallbackEntry(); return; }

      var rawDate = audit.stored_at || audit.timestamp || audit.date;
      var date = rawDate
        ? new Date(rawDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'recently';

      var scores = audit.scores || {};
      var psiUnavailable = ['seo', 'performance', 'accessibility', 'best_practices']
        .every(function(k) { return !scores[k]; });

      var scoreBlocks = SCORE_ORDER.map(function(k) {
        var v = scores[k];
        var hasScore = v !== undefined && v > 0;
        var valClass = hasScore ? 'live-score-val ' + colorClass(v) : 'live-score-val';
        var valStyle = hasScore ? '' : ' style="color:var(--border);"';
        return '<div class="live-score-tile">' +
          '<div class="' + valClass + '"' + valStyle + '>' + (hasScore ? v + '%' : '—') + '</div>' +
          '<div class="live-score-lbl">' + SCORE_LABEL[k] + '</div>' +
        '</div>';
      }).join('');

      var checks = audit.checks || [];
      var checkItems = checks.map(function(c) {
        var passClass = c.pass ? 'pv-gold' : 'pv-red';
        var nameColor = c.pass ? 'var(--muted)' : '#E05A3A';
        return '<div class="live-check-item">' +
          '<span class="' + passClass + '" style="font-size:13px;">' + (c.pass ? '✓' : '✗') + '</span>' +
          '<span style="font-size:12px;text-transform:uppercase;letter-spacing:0.07em;color:' + nameColor + ';">' + c.name + '</span>' +
        '</div>';
      }).join('');

      list.innerHTML =
        '<div class="pt-entry" style="padding-top:20px;">' +
          '<div class="pt-header">' +
            '<div>' +
              '<a href="https://droptimize.org" target="_blank" rel="noopener" class="pt-domain">droptimize.org <span class="p-arrow">↗</span></a>' +
              '<span class="pt-biz">Droptimize - by OYE Creations</span>' +
            '</div>' +
            '<div class="p-tags">' +
              '<span class="p-tag p-tag--gold">Live</span>' +
              '<span class="p-date">' + date + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="live-score-grid">' + scoreBlocks + '</div>' +
          (checks.length ? '<div class="live-check-grid">' + checkItems + '</div>' : '') +
          (psiUnavailable ? '<p style="font-family:\'DM Mono\',monospace;font-size:12px;letter-spacing:0.06em;color:var(--muted);margin-top:10px;">Lighthouse scores unavailable - PSI quota. Security verified via headers.</p>' : '') +
        '</div>';
    })
    .catch(function() {
      var list = document.getElementById('live-audit-list');
      if (list) list.innerHTML = fallbackEntry();
    });
})();

(function() {
  var btn = document.getElementById('pt-toggle-btn');
  if (!btn) return;
  var hidden = document.querySelectorAll('.pt-entry--hidden');
  var PAGE = 10;
  var shown = 0;

  btn.addEventListener('click', function() {
    var expanded = btn.getAttribute('aria-expanded') === 'true';
    if (expanded) {
      // collapse back
      shown = 0;
      hidden.forEach(function(el) { el.classList.add('pt-entry--hidden'); });
      btn.textContent = 'Show ' + hidden.length + ' more';
      btn.setAttribute('aria-expanded', 'false');
    } else {
      // reveal up to next PAGE
      var toShow = Math.min(shown + PAGE, hidden.length);
      for (var i = shown; i < toShow; i++) {
        hidden[i].classList.remove('pt-entry--hidden');
      }
      shown = toShow;
      if (shown >= hidden.length) {
        btn.textContent = 'Show less';
        btn.setAttribute('aria-expanded', 'true');
      } else {
        btn.textContent = 'Show ' + Math.min(PAGE, hidden.length - shown) + ' more';
      }
    }
  });
})();

(function() {
  var form = document.getElementById('contact-form');
  if (!form) return;
  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    var btn = form.querySelector('.form-submit');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      var res = await fetch('/api/submit', {
        method: 'POST',
        body: new FormData(form),
        headers: { 'Accept': 'application/json' }
      });
      if (res.ok) {
        form.innerHTML = '<div class="form-sent">Request sent. We\'ll run your audit and be in touch shortly.</div>';
      } else {
        btn.disabled = false;
        btn.textContent = 'Send Audit Request';
      }
    } catch(err) {
      btn.disabled = false;
      btn.textContent = 'Send Audit Request';
    }
  });
})();
