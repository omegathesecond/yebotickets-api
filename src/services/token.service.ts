import jwt from 'jsonwebtoken';
import { ApiError } from '../middleware/error.middleware';

/**
 * Centralised JWT minting/verification so every entry point (OTP verify,
 * organizer login, token refresh) issues identical, consistent tokens instead
 * of each re-implementing `jwt.sign` (this logic was previously duplicated in
 * auth.service.ts and organizer.controller.ts — DRY).
 *
 * Two token kinds:
 *  - access token  — short lived ({@link ACCESS_EXPIRES}), signed with JWT_SECRET,
 *    the bearer token `protect` verifies on every request.
 *  - refresh token — long lived ({@link REFRESH_EXPIRES}), signed with a dedicated
 *    JWT_REFRESH_SECRET and carrying `type: 'refresh'` so it can never be
 *    accepted as an access token. Used by POST /api/auth/refresh-token to mint a
 *    fresh access token without forcing the user to log in again.
 *
 * Secrets fall back to JWT_SECRET (and finally the legacy 'fallbacksecret' the
 * rest of the codebase already uses) so an environment that has not yet been
 * given a separate refresh secret still works rather than crashing at boot.
 */
const accessSecret = (): string => process.env.JWT_SECRET || 'fallbacksecret';
const refreshSecret = (): string =>
  process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'fallbacksecret';

const ACCESS_EXPIRES = (): string => process.env.JWT_EXPIRES_IN || '24h';
const REFRESH_EXPIRES = (): string => process.env.JWT_REFRESH_EXPIRES_IN || '30d';

export interface RefreshTokenPayload {
  id: string;
  role: string;
  sessionVersion: number;
  type: 'refresh';
}

export interface AuthTokens {
  /** Short-lived bearer/access token. */
  token: string;
  /** Long-lived refresh token, exchanged at POST /api/auth/refresh-token. */
  refreshToken: string;
}

/** Mint a short-lived access (bearer) token. */
export const generateAccessToken = (userId: string, role: string, sessionVersion: number): string => {
  const options = { expiresIn: ACCESS_EXPIRES() };
  return jwt.sign({ id: userId, role, sessionVersion }, accessSecret(), options as jwt.SignOptions);
};

/** Mint a long-lived refresh token (carries type:'refresh'). */
export const generateRefreshToken = (userId: string, role: string, sessionVersion: number): string => {
  const options = { expiresIn: REFRESH_EXPIRES() };
  return jwt.sign({ id: userId, role, sessionVersion, type: 'refresh' }, refreshSecret(), options as jwt.SignOptions);
};

/** Mint both tokens for a freshly authenticated user. */
export const generateAuthTokens = (userId: string, role: string, sessionVersion: number): AuthTokens => ({
  token: generateAccessToken(userId, role, sessionVersion),
  refreshToken: generateRefreshToken(userId, role, sessionVersion),
});

/**
 * Verify a refresh token and return its payload. Throws a loud 401 ApiError if
 * the token is missing/expired/tampered, or is not actually a refresh token
 * (e.g. someone replays an access token here) — never silently accepts it.
 */
export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(token, refreshSecret());
  } catch {
    throw new ApiError('Invalid or expired refresh token', 401);
  }

  if (typeof decoded === 'string' || decoded.type !== 'refresh' || !decoded.id) {
    throw new ApiError('Invalid refresh token', 401);
  }

  assertSessionVersion(decoded.sessionVersion);
  return { sessionVersion: decoded.sessionVersion as number, id: decoded.id as string, role: (decoded.role as string) || 'user', type: 'refresh' };
};

/** Missing versions are invalid too: pre-revocation tokens cannot be upgraded. */
function assertSessionVersion(version: unknown): asserts version is number {
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new ApiError('Sign in required', 401);
  }
}

export const assertCurrentSession = (
  payload: { sessionVersion?: unknown },
  user: { sessionVersion: number } | null
): void => {
  assertSessionVersion(payload.sessionVersion);
  if (!user || payload.sessionVersion !== user.sessionVersion) {
    throw new ApiError('Sign in required', 401);
  }
};
