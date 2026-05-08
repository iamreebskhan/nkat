/**
 * AuthContext: the authenticated principal for a request.
 *
 * Plain interface (not a class) so it travels easily through Nest's request
 * scope without DI gymnastics.
 */
export interface AuthContext {
  orgId: string;
  userId: string | null;
  role: 'employee' | 'reviewer' | 'admin' | 'consultant' | 'system';
}

declare module 'express' {
  interface Request {
    auth?: AuthContext;
  }
}
