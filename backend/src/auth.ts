import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function tokensMatch(provided: string, configured: string): boolean {
  const providedBytes = Buffer.from(provided);
  const configuredBytes = Buffer.from(configured);
  if (providedBytes.length !== configuredBytes.length) return false;
  return timingSafeEqual(providedBytes, configuredBytes);
}

function requireToken(
  configuredToken: string,
  req: Pick<Request, 'header'>,
  res: Pick<Response, 'status' | 'json'>,
  next: NextFunction,
): void {
  const authorization = req.header('authorization');
  const providedToken = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';

  if (!providedToken || !tokensMatch(providedToken, configuredToken)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  next();
}

/** Protects the private single-user deployment when COACH_API_TOKEN is set. */
export function requireApiToken(
  req: Pick<Request, 'header'>,
  res: Pick<Response, 'status' | 'json'>,
  next: NextFunction,
): void {
  const configuredToken = process.env.COACH_API_TOKEN?.trim();
  if (!configuredToken) {
    next();
    return;
  }
  requireToken(configuredToken, req, res, next);
}

/**
 * Admin routes are always closed unless an explicit admin token exists. This
 * keeps the legacy profile/database API unavailable on a public deployment.
 */
export function requireConfiguredToken(
  req: Pick<Request, 'header'>,
  res: Pick<Response, 'status' | 'json'>,
  next: NextFunction,
): void {
  const configuredToken = (process.env.COACH_ADMIN_TOKEN || process.env.COACH_API_TOKEN || '').trim();
  if (!configuredToken) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  requireToken(configuredToken, req, res, next);
}

