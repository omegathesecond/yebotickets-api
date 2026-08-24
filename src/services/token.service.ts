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
 * JWT_SECRET is mandatory — there is no fallback literal. An environment
 * that hasn't been given one fails loudly at startup rather than silently
 * signing/verifying every token with a well-known constant (CLAUDE.md: no
 * silent fallbacks). JWT_REFRESH_SECRET may fall back to JWT_SECRET so a
 * dedicated refresh secret is optional, but a secret of some kind is not.
 */
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is not set — refusing to start');
}

const accessSecret = (): string => process.env.JWT_SECRET as string;
const refreshSecret = (): string => process.env.JWT_REFRESH_SECRET || (process.env.JWT_SECRET as string);

const ACCESS_EXPIRES = (): string => process.env.JWT_EXPIRES_IN || '24h';
const REFRESH_EXPIRES = (): string => process.env.JWT_REFRESH_EXPIRES_IN || '30d';

export interface RefreshTokenPayload {
  id: string;
  role: string;
  type: 'refresh';
}

export interface AuthTokens {
  /** Short-lived bearer/access token. */
  token: string;
  /** Long-lived refresh token, exchanged at POST /api/auth/refresh-token. */
  refreshToken: string;
}

/** Mint a short-lived access (bearer) token. */
export const generateAccessToken = (userId: string, role: string): string => {
  const options = { expiresIn: ACCESS_EXPIRES() };
  return jwt.sign({ id: userId, role }, accessSecret(), options as jwt.SignOptions);
};

/** Mint a long-lived refresh token (carries type:'refresh'). */
export const generateRefreshToken = (userId: string, role: string): string => {
  const options = { expiresIn: REFRESH_EXPIRES() };
  return jwt.sign({ id: userId, role, type: 'refresh' }, refreshSecret(), options as jwt.SignOptions);
};

/** Mint both tokens for a freshly authenticated user. */
export const generateAuthTokens = (userId: string, role: string): AuthTokens => ({
  token: generateAccessToken(userId, role),
  refreshToken: generateRefreshToken(userId, role),
});

/**
 * Verify a refresh token and return its payload. Throws a loud 401 ApiError if
 * the token is missing/expired/tampered, or is not actually a refresh token
 * (e.g. someone replays an access token here) — never silently accepts it.
 */
export interface AccessTokenPayload {
  id: string;
}

/**
 * Verify an access (bearer) token, throwing a loud 401 ApiError if it's
 * missing/expired/tampered. Centralises access-token verification so
 * `protect` doesn't read process.env.JWT_SECRET directly.
 */
export const verifyAccessToken = (token: string): AccessTokenPayload => {
  try {
    const decoded = jwt.verify(token, accessSecret());
    if (typeof decoded === 'string' || !decoded.id) {
      throw new Error('malformed payload');
    }
    return { id: decoded.id as string };
  } catch {
    throw new ApiError('Not authorized, invalid token', 401);
  }
};

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

  return { id: decoded.id as string, role: (decoded.role as string) || 'user', type: 'refresh' };
};
