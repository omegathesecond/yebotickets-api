import jwt from "jsonwebtoken";
import { ApiError } from "../middleware/error.middleware";

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
 */
const requiredSecret = (name: "JWT_SECRET" | "JWT_REFRESH_SECRET"): string => {
  const secret = process.env[name];
  if (!secret?.trim())
    throw new ApiError(`Authentication configuration missing: ${name}`, 503);
  return secret;
};
const accessSecret = () => requiredSecret("JWT_SECRET");
const refreshSecret = () => requiredSecret("JWT_REFRESH_SECRET");

const ACCESS_EXPIRES = (): string => process.env.JWT_EXPIRES_IN || "24h";
const REFRESH_EXPIRES = (): string =>
  process.env.JWT_REFRESH_EXPIRES_IN || "30d";

export interface RefreshTokenPayload {
  id: string;
  role: string;
  type: "refresh";
  authVersion: number;
}

export interface AuthTokens {
  /** Short-lived bearer/access token. */
  token: string;
  /** Long-lived refresh token, exchanged at POST /api/auth/refresh-token. */
  refreshToken: string;
}

/** Mint a short-lived access (bearer) token. */
export const generateAccessToken = (
  userId: string,
  role: string,
  authVersion: number,
): string => {
  assertAuthVersion(authVersion);
  const options = { expiresIn: ACCESS_EXPIRES() };
  return jwt.sign(
    { id: userId, role, type: "access", authVersion },
    accessSecret(),
    options as jwt.SignOptions,
  );
};

/** Mint a long-lived refresh token (carries type:'refresh'). */
export const generateRefreshToken = (
  userId: string,
  role: string,
  authVersion: number,
): string => {
  assertAuthVersion(authVersion);
  const options = { expiresIn: REFRESH_EXPIRES() };
  return jwt.sign(
    { id: userId, role, type: "refresh", authVersion },
    refreshSecret(),
    options as jwt.SignOptions,
  );
};

/** Mint both tokens for a freshly authenticated user. */
export const generateAuthTokens = (
  userId: string,
  role: string,
  authVersion: number,
): AuthTokens => ({
  token: generateAccessToken(userId, role, authVersion),
  refreshToken: generateRefreshToken(userId, role, authVersion),
});

/**
 * Verify a refresh token and return its payload. Throws a loud 401 ApiError if
 * the token is missing/expired/tampered, or is not actually a refresh token
 * (e.g. someone replays an access token here) — never silently accepts it.
 */
export const verifyRefreshToken = (token: string): RefreshTokenPayload => ({
  ...verifyToken(token, "refresh"),
  type: "refresh",
});

const validAuthVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const assertAuthVersion = (value: number) => {
  if (!validAuthVersion(value))
    throw new ApiError("Account session version is invalid", 500);
};

/** One strict verifier for both purposes; configuration errors remain explicit503. */
function verifyToken(token: string, type: "access" | "refresh") {
  const secret = type === "access" ? accessSecret() : refreshSecret();
  let decoded: jwt.JwtPayload | string;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch {
    throw new ApiError(
      type === "access"
        ? "Not authorized, invalid token"
        : "Invalid or expired refresh token",
      401,
    );
  }
  if (
    typeof decoded === "string" ||
    decoded.type !== type ||
    typeof decoded.id !== "string" ||
    !decoded.id ||
    typeof decoded.role !== "string" ||
    !validAuthVersion(decoded.authVersion)
  )
    throw new ApiError(
      type === "access"
        ? "Not authorized, invalid session. Sign in again."
        : "Invalid refresh token",
      401,
    );
  return {
    id: decoded.id,
    role: decoded.role,
    type,
    authVersion: decoded.authVersion,
  };
}

/** A refresh token, legacy token or malformed session never becomes access. */
export function verifyAccessToken(token: string): {
  id: string;
  authVersion: number;
} {
  const { id, authVersion } = verifyToken(token, "access");
  return { id, authVersion };
}
