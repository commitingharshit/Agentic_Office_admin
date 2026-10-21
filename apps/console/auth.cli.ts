// Only for the Better Auth CLI (`npx auth generate --config auth.cli.ts`), which wants an exported `auth`.
// The app itself builds it lazily in src/lib/instance.ts.
import { createAuth } from './src/lib/auth';

export const auth = createAuth();
