// Personalizes the "You're Booked" label from the ?plan= query param.
// Kept external (not inline) because the site CSP has no 'unsafe-inline' for scripts.
(function () {
  var params = new URLSearchParams(window.location.search);
  var plan = params.get("plan") || "";
  var labels = {
    single: "Single Site - $549",
    standard: "Standard - $1,599",
    professional: "Professional - $2,999",
    "audit-watch-solo": "Audit Watch Solo",
    "audit-watch-business": "Audit Watch Business",
    "audit-watch-agency": "Audit Watch Agency",
    "audit-watch-solo-annual": "Audit Watch Solo (Annual)",
    "audit-watch-business-annual": "Audit Watch Business (Annual)",
    "audit-watch-agency-annual": "Audit Watch Agency (Annual)"
  };
  var el = document.getElementById("planLabel");
  if (el && labels[plan]) el.textContent = labels[plan];
})();
