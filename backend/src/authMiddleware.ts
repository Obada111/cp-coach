import type { NextFunction, Request, Response } from 'express';

export interface AuthenticatedUser {
  userId: string;
  email?: string;
  accessToken: string;
  claims: Record<string, unknown>;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  socialUser?: AuthenticatedUser;
}

export interface AuthVerificationOptions {
  /** Require SUPABASE_URL and SUPABASE_ANON_KEY instead of allowing test claims. */
  requireSupabaseConfig?: boolean;
  /** Allow unsigned test JWTs when Supabase is not configured. Never enabled in production. */
  allowTestFallback?: boolean;
}

export type AuthVerificationResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; status: number; message: string };

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}

function normalizedSupabaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function expectedIssuer(supabaseUrl: string): string {
  return `${normalizedSupabaseUrl(supabaseUrl)}/auth/v1`;
}

function tokenAudienceMatches(audience: unknown): boolean {
  if (audience === undefined || audience === null) return true;
  if (typeof audience === 'string') return audience === 'authenticated';
  return Array.isArray(audience) && audience.includes('authenticated');
}

function unauthorized(message: string): AuthVerificationResult {
  return { ok: false, status: 401, message };
}

/**
 * Verifies a Supabase access token. The user identity is always derived from
 * server-verified data, never from a request body, query parameter, or browser
 * generated client id.
 */
export async function verifySupabaseAccessToken(
  token: string,
  options: AuthVerificationOptions = {},
): Promise<AuthVerificationResult> {
  const claims = decodeJwtClaims(token);
  if (!claims) return unauthorized('Invalid authentication token.');

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) {
    return unauthorized('Session expired. Please sign in again.');
  }
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > nowSeconds + 60)) {
    return unauthorized('Authentication token is not valid yet.');
  }
  if (!isValidUserId(claims.sub)) {
    return unauthorized('Invalid user identity in authentication token.');
  }
  if (claims.role !== 'authenticated') {
    return unauthorized('Invalid user role.');
  }
  if (!tokenAudienceMatches(claims.aud)) {
    return unauthorized('Invalid token audience.');
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  const testFallbackAllowed =
    options.allowTestFallback === true &&
    isTestEnvironment() &&
    process.env.NODE_ENV !== 'production';

  if (options.requireSupabaseConfig && (!supabaseUrl || !anonKey)) {
    return { ok: false, status: 503, message: 'Authentication service is not configured for this deployment.' };
  }

  const unconfigured =
    !supabaseUrl ||
    !anonKey ||
    process.env.MOCK_SUPABASE_AUTH === 'true';
  if (unconfigured) {
    if (!testFallbackAllowed) {
      return {
        ok: false,
        status: 503,
        message: 'Authentication service is not configured for this deployment.',
      };
    }
    return {
      ok: true,
      user: {
        userId: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        accessToken: token,
        claims,
      },
    };
  }

  const canonicalUrl = normalizedSupabaseUrl(supabaseUrl!);
  if (claims.iss !== undefined && claims.iss !== expectedIssuer(canonicalUrl)) {
    return unauthorized('Invalid token issuer.');
  }

  let response: globalThis.Response;
  try {
    response = await globalThis.fetch(new URL('/auth/v1/user', `${canonicalUrl}/`), {
      headers: {
        apikey: anonKey!,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return {
      ok: false,
      status: 503,
      message: 'Could not reach the authentication service. Please retry.',
    };
  }

  if (response.status === 401 || response.status === 403) {
    return unauthorized('Session is invalid or has been revoked.');
  }
  if (!response.ok) {
    return { ok: false, status: 503, message: 'Authentication service is temporarily unavailable.' };
  }

  let authUser: { id?: unknown; email?: unknown };
  try {
    authUser = (await response.json()) as { id?: unknown; email?: unknown };
  } catch {
    return { ok: false, status: 503, message: 'Authentication service returned an unexpected response.' };
  }

  if (!isValidUserId(authUser.id) || authUser.id !== claims.sub) {
    return unauthorized('User identity mismatch.');
  }

  return {
    ok: true,
    user: {
      userId: authUser.id,
      email: typeof authUser.email === 'string'
        ? authUser.email
        : (typeof claims.email === 'string' ? claims.email : undefined),
      accessToken: token,
      claims,
    },
  };
}

function sendAuthFailure(
  res: Response,
  result: Extract<AuthVerificationResult, { ok: false }>,
): void {
  res.status(result.status).json({ error: result.message });
}

/**
 * Middleware that strictly verifies a Supabase session Bearer token.
 * Missing, expired, revoked, malformed, anonymous, or mismatched tokens are
 * rejected before a route can observe any request-supplied identity.
 */
export async function requireAuthUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.header('authorization') || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(authHeader);

  if (!match) {
    res.status(401).json({ error: 'Authentication required. Missing or malformed Authorization header.' });
    return;
  }

  const result = await verifySupabaseAccessToken(match[1], { allowTestFallback: true });
  if (!result.ok) {
    sendAuthFailure(res, result);
    return;
  }

  const request = req as AuthenticatedRequest;
  request.user = result.user;
  request.socialUser = result.user;
  next();
}

/**
 * Optional authentication for genuinely public endpoints. Invalid tokens are
 * ignored rather than granting identity, and no fallback client id is ever
 * trusted.
 */
export async function optionalAuthUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.header('authorization') || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(authHeader);
  if (!match) return next();

  const result = await verifySupabaseAccessToken(match[1], { allowTestFallback: true });
  if (result.ok) {
    const request = req as AuthenticatedRequest;
    request.user = result.user;
    request.socialUser = result.user;
  }
  next();
}
