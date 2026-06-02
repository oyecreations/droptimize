# CLAUDE.md (Droptimize)

Inherits `../CLAUDE.md` (OYE umbrella) and `~/.claude/CLAUDE.md` (universal).

Droptimize (droptimize.org) is the website-audit product: PageSpeed/SEO/security
audits, website-build tiers, and Audit Watch self-serve site monitoring with web push.

## Key rules
- It is an installable PWA with a strict CSP: `script-src 'self'` blocks ALL inline
  scripts. Every script must be an external `/assets/` file. No inline `<script>`,
  no inline event handlers.
- CF Pages, auto-deploys on push to `main`.
- Audit Watch uses a daily cron worker (`droptimize-monitor`) that diffs scores/
  headers/uptime and sends VAPID web push. PSI + VAPID keys live in wrangler config /
  `~/Documents/OYE-Business/`.
- Pricing is website-build tiers + Audit Watch monitoring (fixes NOT included in
  monitoring). Stripe IDs in `wrangler.toml`.
