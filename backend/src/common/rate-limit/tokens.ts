/**
 * DI tokens for rate-limit module. Lives in its own file so other
 * files in the module can import it without creating a cycle through
 * `rate-limit.module.ts`.
 */
export const RATE_LIMIT_STORE_TOKEN = Symbol('RATE_LIMIT_STORE');
export const OVERRIDE_RESOLVER_TOKEN = Symbol('RATE_LIMIT_OVERRIDE_RESOLVER');
