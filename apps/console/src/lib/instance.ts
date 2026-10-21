import { createAuth, type Auth } from './auth';

let instance: Auth | undefined;
/** The process-wide Better Auth instance, built on first use. */
export const getAuth = (): Auth => (instance ??= createAuth());
