/**
 * Block non-web files that ship in the repo but must never be served publicly:
 * the _private/ no-deploy folder, VCS/dotfiles, worker source, and build/config
 * files (wrangler.toml, package.json, *.md incl CLAUDE.md/README.md, source maps).
 * A Pages Function outranks static assets AND their edge cache, so this holds
 * even on direct-upload deploys that ship on-disk files. Everything else passes.
 */
function isBlocked(p) {
  return p.startsWith("/_private/") || p.startsWith("/.git") || p.startsWith("/workers/") ||
    p === "/.env" || p === "/.DS_Store" ||
    p === "/package.json" || p === "/package-lock.json" || p === "/tsconfig.json" ||
    p.endsWith(".md") || p.endsWith(".toml") || p.endsWith(".map");
}
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (isBlocked(url.pathname)) return new Response("Not found", { status: 404 });
  return context.next();
}
