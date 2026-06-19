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

  var LOGO_SVG = '<svg class="live-audit-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 56" aria-hidden="true" fill="none"><path d="M6,20 A18,18 0 0,1 42,20 Q42,38 24,54 Q6,38 6,20 Z" fill="#C9A84C"/><polyline points="13,28 24,14 35,28" stroke="#111111" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function fallbackEntry() {
    return '<div class="live-audit-bar">' +
      '<div class="live-audit-meta">' +
        '<div class="live-audit-top">' + LOGO_SVG + '<div class="live-audit-indicator"><span class="live-pulse"></span><span class="live-audit-lbl">Live</span></div></div>' +
        '<div class="live-audit-bottom"><a href="https://droptimize.org" target="_blank" rel="noopener" class="live-audit-domain">droptimize.org &#x2197;</a><span class="live-audit-date">Audit runs every Monday</span></div>' +
      '</div>' +
      '<div class="live-score-grid">' +
        ['Search Engine','Security','Performance','Accessibility','Best Practices'].map(function(l) {
          return '<div class="live-score-tile"><div class="live-score-val" style="color:var(--border);">-</div><div class="live-score-lbl">' + l + '</div></div>';
        }).join('') +
      '</div>' +
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

      var SCORE_SHORT = { seo:'Search Engine', security:'Security', performance:'Performance', accessibility:'Accessibility', best_practices:'Best Practices' };

      var scoreBlocks = SCORE_ORDER.map(function(k) {
        var v = scores[k];
        var hasScore = v !== undefined && v > 0;
        var valClass = hasScore ? 'live-score-val ' + colorClass(v) : 'live-score-val';
        var valStyle = hasScore ? '' : ' style="color:var(--border);"';
        return '<div class="live-score-tile">' +
          '<div class="' + valClass + '"' + valStyle + '>' + (hasScore ? v + '%' : '-') + '</div>' +
          '<div class="live-score-lbl">' + SCORE_SHORT[k] + '</div>' +
        '</div>';
      }).join('');

      list.innerHTML =
        '<div class="live-audit-bar">' +
          '<div class="live-audit-meta">' +
            '<div class="live-audit-top">' + LOGO_SVG + '<div class="live-audit-indicator"><span class="live-pulse"></span><span class="live-audit-lbl">Live</span></div></div>' +
            '<div class="live-audit-bottom"><a href="https://droptimize.org" target="_blank" rel="noopener" class="live-audit-domain">droptimize.org &#x2197;</a><span class="live-audit-date">' + date + '</span></div>' +
          '</div>' +
          '<div class="live-score-grid">' + scoreBlocks + '</div>' +
        '</div>' +
        '';
    })
    .catch(function() {
      var list = document.getElementById('live-audit-list');
      if (list) list.innerHTML = fallbackEntry();
    });
})();

(function() {
  // Portfolio accordion
  document.querySelectorAll('.pt-chevron').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var row = btn.closest('.pt-row');
      var open = row.getAttribute('data-open') === 'true';
      row.setAttribute('data-open', open ? 'false' : 'true');
      btn.setAttribute('aria-label', (open ? 'Expand ' : 'Collapse ') + (row.querySelector('.pt-row-domain') || {}).textContent);
    });
  });

  // Show more hidden rows
  var moreBtn = document.getElementById('pt-more-btn');
  if (moreBtn) {
    var hiddenRows = Array.from(document.querySelectorAll('.pt-row--hidden'));
    var PAGE = 10;
    var shown = 0;

    if (!hiddenRows.length) { document.getElementById('pt-more-wrap').style.display = 'none'; }

    moreBtn.addEventListener('click', function() {
      var allShown = !hiddenRows.some(function(r) { return r.classList.contains('pt-row--hidden'); });
      if (allShown) {
        shown = 0;
        hiddenRows.forEach(function(r) { r.classList.add('pt-row--hidden'); r.setAttribute('data-open','false'); });
        moreBtn.textContent = 'Show ' + hiddenRows.length + ' more';
      } else {
        var toShow = Math.min(shown + PAGE, hiddenRows.length);
        for (var i = shown; i < toShow; i++) { hiddenRows[i].classList.remove('pt-row--hidden'); }
        shown = toShow;
        moreBtn.textContent = shown >= hiddenRows.length ? 'Show less' : 'Show ' + Math.min(PAGE, hiddenRows.length - shown) + ' more';
      }
    });
  }
})();

(function() {
  var form = document.getElementById('contact-form');
  if (!form) return;

  var ORDER = ['seo', 'security', 'performance', 'accessibility', 'best_practices'];
  var LABEL = { seo:'SEO', security:'Security', performance:'Performance', accessibility:'Accessibility', best_practices:'Best Practices' };

  function colorClass(n) {
    if (n == null) return '';
    return n >= 90 ? 'pv-gold' : n >= 70 ? 'pv-amber' : 'pv-red';
  }

  function renderScores(scores, website) {
    var tiles = ORDER.map(function(k) {
      var v   = scores[k];
      var cls = 'live-score-val' + (v != null ? ' ' + colorClass(v) : '');
      return '<div class="live-score-tile">' +
        '<div class="' + cls + '">' + (v != null ? v + '%' : ', ') + '</div>' +
        '<div class="live-score-lbl">' + LABEL[k] + '</div>' +
      '</div>';
    }).join('');

    return '<div class="audit-inline-result">' +
      '<p class="eyebrow" style="margin-bottom:14px;">Audit Complete</p>' +
      '<p style="font-family:\'Playfair Display\',serif;font-size:20px;font-weight:700;color:var(--warm);margin-bottom:6px;word-break:break-all;">' + website + '</p>' +
      '<p style="font-family:\'DM Mono\',monospace;font-size:12px;color:var(--muted);letter-spacing:0.05em;margin-bottom:24px;">Results emailed to you. We\'ll follow up with a full breakdown.</p>' +
      '<div class="live-score-grid" style="margin-bottom:24px;">' + tiles + '</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;">' +
        '<a href="#pricing" class="cta" style="font-size:13px;padding:12px 24px;">See rebuild packages &rarr;</a>' +
        '<a href="#pricing" style="font-family:\'DM Mono\',monospace;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);border:1px solid var(--border);padding:12px 20px;text-decoration:none;transition:color 150ms,border-color 150ms;" onmouseover="this.style.color=\'var(--gold)\';this.style.borderColor=\'var(--gold-dim)\';" onmouseout="this.style.color=\'var(--muted)\';this.style.borderColor=\'var(--border)\';">Audit Watch plans</a>' +
      '</div>' +
    '</div>';
  }

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    var btn     = form.querySelector('.form-submit');
    var website = (form.querySelector('[name="website"]') || {}).value || '';
    website = website.trim();

    btn.disabled    = true;
    btn.textContent = website ? 'Running audit...' : 'Sending...';

    // Show loading dots while PSI runs
    var loader = document.createElement('div');
    loader.className = 'audit-loader';
    loader.innerHTML = website
      ? '<span class="audit-loader-dot"></span><span class="audit-loader-dot"></span><span class="audit-loader-dot"></span><span style="font-family:\'DM Mono\',monospace;font-size:12px;letter-spacing:0.08em;color:var(--muted);margin-left:10px;">Scanning ' + website + '</span>'
      : '';
    if (website) form.appendChild(loader);

    try {
      var res  = await fetch('/api/submit', { method:'POST', body:new FormData(form), headers:{'Accept':'application/json'} });
      var data = res.ok ? await res.json() : null;

      if (data && data.ok && data.scores) {
        form.insertAdjacentHTML('afterend', renderScores(data.scores, website));
        form.remove();
      } else if (data && data.ok) {
        form.insertAdjacentHTML('afterend', '<p class="eyebrow" style="margin-bottom:12px;">Request Sent</p><p style="color:var(--muted);font-family:\'DM Mono\',monospace;font-size:13px;">We\'ll run your audit and be in touch shortly.</p>');
        form.remove();
      } else {
        if (loader.parentNode) loader.remove();
        btn.disabled    = false;
        btn.textContent = 'Send Audit Request';
      }
    } catch(err) {
      if (loader.parentNode) loader.remove();
      btn.disabled    = false;
      btn.textContent = 'Send Audit Request';
    }
  });
})();

// Audit log dropdowns
(function() {
  var SCORE_COLS = ['seo', 'security', 'performance', 'accessibility', 'best_practices'];

  function scoreColor(n) {
    if (!n || n <= 0) return 'color:var(--muted);';
    return n >= 90 ? 'color:var(--gold);' : n >= 70 ? 'color:#F59E0B;' : 'color:#E05A3A;';
  }

  function renderHistory(history) {
    if (!history || !history.length) {
      return '<p class="al-empty">No history yet - first automated audit runs Monday.</p>' +
        '<div class="al-cta">Subscribe to <a href="#pricing">Audit Watch</a> to get weekly scores and automatic alerts when they drop.</div>';
    }
    var rows = history.slice().reverse().map(function(entry) {
      var s = entry.scores || {};
      var d = entry.date ? new Date(entry.date + 'T12:00:00Z').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '-';
      var cells = SCORE_COLS.map(function(k) {
        var v = s[k];
        return '<td style="' + scoreColor(v) + '">' + (v > 0 ? v : '-') + '</td>';
      }).join('');
      return '<tr><td class="al-date">' + d + '</td>' + cells + '</tr>';
    }).join('');

    return '<div class="al-table-wrap"><table class="al-table">' +
      '<thead><tr><th>Date</th><th>SEO</th><th>Sec</th><th>Perf</th><th>A11y</th><th>BP</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '<div class="al-cta">Scores can drop between audits. <a href="#pricing">Subscribe to Audit Watch</a> for weekly monitoring and automatic alerts.</div>';
  }

  document.querySelectorAll('.al-btn').forEach(function(btn) {
    var panelId = btn.getAttribute('aria-controls');
    var panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) return;

    btn.addEventListener('click', function() {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      if (panel.dataset.loaded) return;

      var domain = btn.dataset.domain;
      panel.innerHTML = '<p class="al-empty">Loading...</p>';
      fetch('/api/audit/history?domain=' + encodeURIComponent(domain))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          panel.innerHTML = renderHistory(data.history);
          panel.dataset.loaded = '1';
        })
        .catch(function() {
          panel.innerHTML = '<p class="al-empty">Could not load history.</p>';
        });
    });
  });

  // Sticky mobile CTA: hide it while the hero's own CTA is on screen so the
  // first view isn't two stacked gold buttons; reveal once the hero scrolls away.
  var stickyCta = document.querySelector('.mobile-cta');
  var heroCtaRow = document.querySelector('.hero .cta-row');
  if (stickyCta && heroCtaRow && 'IntersectionObserver' in window) {
    stickyCta.classList.add('is-hidden');
    new IntersectionObserver(function(entries) {
      stickyCta.classList.toggle('is-hidden', entries[0].isIntersecting);
    }, { rootMargin: '0px 0px -40px 0px' }).observe(heroCtaRow);
  }
})();
