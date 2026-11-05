import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import {
  verifySupabaseAccessToken,
  type AuthenticatedUser,
} from './authMiddleware.js';

export type AuthenticatedSocialUser = AuthenticatedUser;

export interface AuthenticatedSocialRequest extends Request {
  socialUser?: AuthenticatedSocialUser;
}

export async function requireSupabaseUser(
  req: Request,
  res: ExpressResponse,
  next: NextFunction,
): Promise<void> {
  const authorization = req.header('authorization') || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) {
    res.status(401).json({ error: 'A valid signed-in Supabase session is required for social features.' });
    return;
  }

  const result = await verifySupabaseAccessToken(match[1], {
    requireSupabaseConfig: true,
  });
  if (!result.ok) {
    if (result.status === 401) {
      res.status(401).json({ error: 'A valid signed-in Supabase session is required for social features.' });
      return;
    }
    res.status(result.status).json({ error: result.message });
    return;
  }

  (req as AuthenticatedSocialRequest).socialUser = result.user;
  next();
}
