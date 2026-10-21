import { NextResponse, type NextRequest } from 'next/server';

/** Tells the server pages which address was asked for, so a person who is not signed in comes back to THAT page after signing in (not always the overview). */
export function proxy(req: NextRequest) {
  const h = new Headers(req.headers);
  h.set('x-ao-path', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers: h } });
}
export const config = { matcher: ['/admin/:path*'] };
