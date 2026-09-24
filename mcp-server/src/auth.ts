import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import { config } from "./config.js";

export type PrincipalType = "staff" | "customer_user" | "machine";

export interface Principal {
  subject: string;
  clientId: string;
  principalType: PrincipalType;
  email?: string;
  name?: string;
  scopes: Set<string>;
  /** The person's company (alias), from the `company` claim. Decides a customer user's home tenant. */
  company?: string;
  /** The client's access token. Only ever used as subject_token for token exchange, never forwarded. */
  accessToken: string;
}

export class AuthError extends Error {
  constructor(message: string, readonly error: "invalid_token" | "insufficient_scope" = "invalid_token") {
    super(message);
  }
}

const jwks = createRemoteJWKSet(new URL(config.jwksUrl));

export async function verifyAccessToken(token: string): Promise<Principal> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.resource, // reject tokens minted for any other resource
      algorithms: ["RS256"],
      clockTolerance: 5,
    });
    if (!payload.sub) throw new AuthError("token has no subject");
    const principalType = (payload.principal_type as PrincipalType | undefined) ?? "customer_user";
    return {
      subject: payload.sub,
      clientId: String(payload.azp ?? payload.client_id ?? "unknown"),
      principalType,
      email: payload.email as string | undefined,
      name: payload.name as string | undefined,
      scopes: new Set(String(payload.scope ?? "").split(" ").filter(Boolean)),
      company: payload.company as string | undefined,
      accessToken: token,
    };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (e instanceof errors.JWTExpired) throw new AuthError("token expired");
    if (e instanceof errors.JWTClaimValidationFailed) throw new AuthError(`token ${e.claim} is not valid for this server`);
    throw new AuthError("token could not be verified");
  }
}

export function bearerChallenge(extra: Record<string, string> = {}): string {
  const params = { resource_metadata: config.resourceMetadataUrl, scope: config.challengeScope, ...extra };
  return "Bearer " + Object.entries(params).map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`).join(", ");
}
