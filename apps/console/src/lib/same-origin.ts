/** A browser POST to a route handler must come from this site: the Origin (or Referer) host must be the Host we were asked for. Server actions have this built in; route handlers do not. */
export function sameOrigin(req: Request): boolean {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const from = req.headers.get('origin') ?? req.headers.get('referer');
  if (!host || !from) return false;
  try { return new URL(from).host === host; } catch { return false; }
}
