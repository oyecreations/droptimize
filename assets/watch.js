// Audit Watch self-serve: subscribe this device to push alerts for a site,
// and manage what it watches. Anonymous, keyed to the browser push endpoint.
(function () {
  "use strict";

  var form = document.getElementById("watchForm");
  var unsupported = document.getElementById("unsupported");
  var unsupportedMsg = document.getElementById("unsupportedMsg");
  var statusEl = document.getElementById("status");
  var submitBtn = document.getElementById("submitBtn");
  var minScore = document.getElementById("minScore");
  var minScoreVal = document.getElementById("minScoreVal");
  var watchingCard = document.getElementById("watchingCard");
  var monitorList = document.getElementById("monitorList");

  var publicKey = null;

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }
  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = "status " + (kind || "info");
  }

  function urlB64ToUint8Array(base64) {
    var padding = "=".repeat((4 - (base64.length % 4)) % 4);
    var b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(b64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isStandalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);

  function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  // Live slider value.
  if (minScore) {
    minScore.addEventListener("input", function () {
      minScoreVal.textContent = minScore.value;
    });
  }

  function freqLabel(f) {
    return f === "daily" ? "daily" : f === "monthly" ? "monthly" : "weekly";
  }

  function renderMonitors(monitors) {
    monitorList.innerHTML = "";
    if (!monitors || !monitors.length) {
      monitorList.innerHTML = '<p class="empty">Nothing yet. Add your first site above.</p>';
      return;
    }
    monitors.forEach(function (m) {
      var row = document.createElement("div");
      row.className = "mon";
      var info = document.createElement("div");
      var u = document.createElement("div");
      u.className = "m-url";
      u.textContent = m.domain || m.url;
      var meta = document.createElement("div");
      meta.className = "m-meta";
      meta.textContent = "checked " + freqLabel(m.frequency) + " · floor " + m.minScore;
      info.appendChild(u);
      info.appendChild(meta);
      var del = document.createElement("button");
      del.className = "m-del";
      del.type = "button";
      del.textContent = "Stop";
      del.addEventListener("click", function () { removeMonitor(m.id, del); });
      row.appendChild(info);
      row.appendChild(del);
      monitorList.appendChild(row);
    });
  }

  async function getSubscription() {
    var reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function loadMonitors() {
    try {
      var sub = await getSubscription();
      if (!sub) { hide(watchingCard); return; }
      var res = await fetch("/api/monitor/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      var data = await res.json();
      if (data.ok && data.monitors && data.monitors.length) {
        renderMonitors(data.monitors);
        show(watchingCard);
      } else {
        hide(watchingCard);
      }
    } catch (e) {
      hide(watchingCard);
    }
  }

  async function removeMonitor(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "..."; }
    try {
      var sub = await getSubscription();
      if (!sub) return;
      await fetch("/api/monitor/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: sub.endpoint, id: id }),
      });
      await loadMonitors();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "Stop"; }
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    var raw = document.getElementById("siteUrl").value.trim();
    var parsed;
    try {
      parsed = new URL(raw);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw 0;
    } catch (_) {
      setStatus("That does not look like a full URL. Include https://", "err");
      return;
    }

    submitBtn.disabled = true;
    setStatus("Asking your permission to send alerts...", "info");

    try {
      var permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("Alerts are blocked. Allow notifications for this site, then try again.", "err");
        submitBtn.disabled = false;
        return;
      }

      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(publicKey),
        });
      }

      var payload = {
        subscription: sub.toJSON(),
        url: raw,
        frequency: document.getElementById("frequency").value,
        minScore: parseInt(minScore.value, 10),
        alertOnDrop: document.getElementById("alertOnDrop").checked,
        alertOnDown: document.getElementById("alertOnDown").checked,
      };

      var res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      if (!data.ok) throw new Error(data.error || "save_failed");

      setStatus("Watching " + data.monitor.domain + ". We will buzz you the moment a score slips.", "ok");
      try {
        await reg.showNotification("Alerts on for " + data.monitor.domain, {
          body: "You are watching this site " + freqLabel(payload.frequency) + ". This is what an alert looks like.",
          icon: "/assets/icons/icon-192.png",
          badge: "/assets/icons/favicon-32.png",
          data: { url: "/watch/" },
        });
      } catch (_) {}
      form.reset();
      minScoreVal.textContent = minScore.value;
      await loadMonitors();
    } catch (err) {
      setStatus("Could not turn on alerts. " + (err && err.message ? err.message : "Please try again."), "err");
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function init() {
    if (!supported()) {
      if (isIOS && !isStandalone) {
        unsupportedMsg.textContent =
          "On iPhone and iPad, add Droptimize to your Home Screen first (Share, then Add to Home Screen), open it from there, and this page will let you turn on alerts.";
      } else {
        unsupportedMsg.textContent =
          "This browser does not support push notifications. Try the latest Chrome, Edge, Firefox, or Safari, or install Droptimize to your Home Screen.";
      }
      show(unsupported);
      return;
    }

    try {
      var res = await fetch("/api/push/config");
      var data = await res.json();
      publicKey = data.publicKey;
    } catch (e) {
      publicKey = null;
    }

    if (!publicKey) {
      unsupportedMsg.textContent = "Alerts are not switched on for this site yet. Check back shortly.";
      show(unsupported);
      return;
    }

    show(form);
    form.addEventListener("submit", onSubmit);
    loadMonitors();
  }

  init();
})();
