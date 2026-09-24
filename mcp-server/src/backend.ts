import { config } from "./config.js";
import type { Role } from "./store.js";

// --- Token exchange (RFC 8693) ----------------------------------------------
// Keycloak mints a 5-min internal JWT for exactly one (subject, tenant, role).
// Cached per that triple until shortly before expiry; never across tenants.

const exchangeCache = new Map<string, { token: string; exp: number }>();

export async function internalToken(subject: string, subjectToken: string, tenantId: number, role: Role): Promise<string> {
  const key = `${subject}|${tenantId}|${role}`;
  const hit = exchangeCache.get(key);
  if (hit && hit.exp - 30_000 > Date.now()) return hit.token;

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${config.exchangeClientId}:${config.exchangeClientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: subjectToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: `tenant-${tenantId} role-${role}`,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  exchangeCache.set(key, { token: body.access_token, exp: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

// --- portal-api / rest-api client ----------------------------------------------------

export class BackendError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type Service = "rest-api" | "portal-api";

export interface BackendClient {
  call<T = unknown>(service: Service, method: string, path: string, body?: unknown): Promise<T>;
  routes: string[];
}

export function backendClient(getToken: () => Promise<string>, tenantId: number): BackendClient {
  const routes: string[] = [];
  return {
    routes,
    async call<T>(service: Service, method: string, path: string, body?: unknown): Promise<T> {
      const base = service === "rest-api" ? `${config.restApiUrl}/1.0` : config.portalApiUrl;
      routes.push(`${service} ${method} ${service === "rest-api" ? "/1.0" : ""}${path.split("?")[0]}`);
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${await getToken()}`, ...(body !== undefined && { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new BackendError(res.status, json?.error ?? `backend returned ${res.status}`);
      return filterTenant(json, tenantId) as T;
    },
  };
}

// Defence in depth: drop list items that claim a different tenant.
function filterTenant(value: unknown, tenantId: number): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => !(v && typeof v === "object" && "tenant_id" in v) || (v as any).tenant_id === tenantId);
  }
  return value;
}
