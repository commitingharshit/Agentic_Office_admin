'use client';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { createAuthClient } from 'better-auth/react';

// oauthProviderClient() resumes the OAuth authorize request after sign-in, so the desktop's browser lands back on its loopback page.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
