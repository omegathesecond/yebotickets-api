import type { Request } from "express";
import { OAuth2Client } from "google-auth-library";
import { workloadAudience } from "@omevision/product-admin-boundary";
import { ApiError } from "../middleware/error.middleware";

const identity = new OAuth2Client();
/** Same audience-bound workload protocol as the existing Learn integration. */
export async function verifyCorporateWorkload(req: Request): Promise<any> {
  const serviceAccount = process.env.CEO_DASHBOARD_SERVICE_ACCOUNT,
    base = process.env.CEO_DASHBOARD_AUDIENCE;
  if (!serviceAccount || !base)
    throw new ApiError("Corporate workload identity is not configured", 503);
  const encoded = req.get("X-Omevision-Staff-Assertion"),
    authorization = req.get("Authorization");
  if (
    !encoded ||
    encoded.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !authorization?.startsWith("Bearer ")
  )
    throw new ApiError("A request-bound corporate assertion is required", 401);
  let assertion: any;
  try {
    assertion = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("Corporate assertion is invalid", 401);
  }
  const audience = workloadAudience(base, assertion);
  const origins: Record<string, string> = {
    "yebotickets-api-prod": "https://api.yebotickets.com",
    "yebotickets-api-dev": "https://dev-api.yebotickets.com",
  };
  if (
    process.env.K_SERVICE &&
    origins[process.env.K_SERVICE] !== new URL(base).origin
  )
    throw new ApiError(
      "Corporate administration audience does not match this Cloud Run service",
      503,
    );
  try {
    const ticket = await identity.verifyIdToken({
      idToken: authorization.slice(7),
      audience,
    });
    const claims = ticket.getPayload();
    if (claims?.email !== serviceAccount || claims.email_verified !== true)
      throw new Error("Unexpected caller");
  } catch {
    throw new ApiError(
      "Corporate workload identity could not be verified",
      401,
    );
  }
  return assertion;
}
