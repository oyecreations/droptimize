/**
 * CLAUDE.md exists at repo root for Claude Code auto-load but must NEVER be
 * served publicly. A Pages Function outranks the static asset (and any edge
 * cache of it), so this masks /CLAUDE.md even though the file ships in the
 * deploy. Everything else passes through untouched.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname === '/CLAUDE.md') return new Response('Not found', { status: 404 });
  return context.next();
}
