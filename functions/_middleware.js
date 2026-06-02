/**
 * Block non-web files that live in the repo for tooling but must never be
 * served publicly (CLAUDE.md for Claude Code; the _private/ no-deploy folder).
 * A Pages Function outranks static assets AND their edge cache, so this holds
 * even on direct-upload deploys that ship on-disk files. Everything else passes.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname === "/CLAUDE.md" || url.pathname.startsWith("/_private/")) {
    return new Response("Not found", { status: 404 });
  }
  return context.next();
}
