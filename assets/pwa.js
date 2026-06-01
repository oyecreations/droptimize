// Register the service worker for the offline shell + installability.
// Kept external (not inline) because the site CSP has no 'unsafe-inline' for scripts.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {
      /* registration failure is non-fatal; the site still works fully online */
    });
  });
}
