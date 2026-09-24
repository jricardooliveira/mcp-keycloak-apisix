import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Redis } from "ioredis";
import { config } from "./config.js";

export type Tier = "T0" | "T1" | "T2" | "T3";

// --- Rate limits per (person, tenant, tier) ------------------------------------
// Fixed one-minute windows in Redis, shared by every MCP replica.

const PER_MINUTE: Record<Tier, number> = { T0: 120, T1: 60, T2: 20, T3: 5 };
const T3_DAILY_CAP = 50;

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });

export async function checkRateLimit(subject: string, tenantId: number | "none", tier: Tier): Promise<string | null> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rl:${subject}:${tenantId}:${tier}:${minute}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 120);
  if (count > PER_MINUTE[tier]) return `rate limit: ${PER_MINUTE[tier]} ${tier} calls per minute per tenant`;
  if (tier === "T3") {
    const day = new Date().toISOString().slice(0, 10);
    const dayKey = `rl:${subject}:${tenantId}:T3:${day}`;
    const daily = await redis.incr(dayKey);
    if (daily === 1) await redis.expire(dayKey, 90_000);
    if (daily > T3_DAILY_CAP) return `daily cap: ${T3_DAILY_CAP} T3 calls per tenant`;
  }
  return null;
}

// --- Argument hashing and redaction -----------------------------------------------

const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`
  : JSON.stringify(v);

export const hashArgs = (args: Record<string, unknown>) => createHash("sha256").update(canonical(args)).digest("hex");

const SENSITIVE = /phone|email|name|text|message|notes|value|^q$/i;
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, SENSITIVE.test(k) && k !== "tenant_id" ? "[redacted]" : v]));
}

// --- Plan -> execute confirmation ids ------------------------------------------------
// Signed, single-use, bound to (subject, tenant, tool, args hash), valid 5 min.

interface ConfirmationClaims { jti: string; sub: string; w: number; tool: string; h: string; exp: number }

const sign = (data: string) => createHmac("sha256", config.confirmationKey).update(data).digest("base64url");

export function issueConfirmation(sub: string, tenantId: number, tool: string, argsHash: string): { id: string; expiresAt: string } {
  const exp = Date.now() + 5 * 60_000;
  const body = Buffer.from(JSON.stringify({ jti: randomUUID(), sub, w: tenantId, tool, h: argsHash, exp } satisfies ConfirmationClaims)).toString("base64url");
  return { id: `${body}.${sign(body)}`, expiresAt: new Date(exp).toISOString() };
}

/** Returns the confirmation's jti if it matches this exact call, else throws with the reason. */
export function verifyConfirmation(id: string, sub: string, tenantId: number, tool: string, argsHash: string): string {
  const [body, mac] = id.split(".");
  if (!body || !mac) throw new Error("malformed confirmation_id");
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error("confirmation_id signature invalid");
  const c = JSON.parse(Buffer.from(body, "base64url").toString()) as ConfirmationClaims;
  if (c.exp < Date.now()) throw new Error("confirmation_id expired; request a new plan");
  if (c.sub !== sub || c.w !== tenantId || c.tool !== tool) throw new Error("confirmation_id was issued for a different person, tenant or tool");
  if (c.h !== argsHash) throw new Error("arguments changed since the plan; request a new plan");
  return c.jti;
}
