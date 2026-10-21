import { toNextJsHandler } from 'better-auth/next-js';
import { NextResponse } from 'next/server';
import { getAuth } from '../../../../lib/instance';
import { keycloakMode } from '../../../../lib/keycloak';

// Lazily built, so `next build` does not need the database or secrets.
export const dynamic = 'force-dynamic';
// Better Auth is retired: with Keycloak configured these endpoints do not exist (it was the sign-in before Keycloak; see docs/plans/2026-10-21-keycloak.md).
const handler = (method: 'GET' | 'POST') => (req: Request) => keycloakMode() ? new NextResponse('Not found', { status: 404 }) : toNextJsHandler(getAuth())[method](req);
export const GET = handler('GET');
export const POST = handler('POST');
