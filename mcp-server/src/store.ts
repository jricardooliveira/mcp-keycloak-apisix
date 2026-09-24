import pg from "pg";
import { config } from "./config.js";

export const ROLES = ["viewer", "support_operator", "supervisor", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const roleRank = (r: Role) => ROLES.indexOf(r);

export interface Tenant { tenantId: number; name: string; zone: string }
export interface Assignment { tenantId: number; role: Role; expiresAt: Date | null; tenantName: string; zone: string }

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

// Assignment decisions are cached for at most 60 s, so removing an
// assignment takes effect within that window.
const CACHE_MS = 60_000;
const assignmentCache = new Map<string, { value: Assignment | null; at: number }>();

export async function getTenant(tenantId: number): Promise<Tenant | null> {
  const { rows } = await pool.query("SELECT tenant_id, name, zone FROM tenants WHERE tenant_id = $1", [tenantId]);
  return rows[0] ? { tenantId: rows[0].tenant_id, name: rows[0].name, zone: rows[0].zone } : null;
}

/** The active assignment of subject to tenant, or null. ROOT has no meaning here. */
export async function getAssignment(subject: string, tenantId: number): Promise<Assignment | null> {
  const key = `${subject}|${tenantId}`;
  const hit = assignmentCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { rows } = await pool.query(
    `SELECT a.tenant_id, a.role, a.expires_at, t.name, t.zone
       FROM assignments a JOIN tenants t USING (tenant_id)
      WHERE a.subject = $1 AND a.tenant_id = $2 AND (a.expires_at IS NULL OR a.expires_at > now())`,
    [subject, tenantId],
  );
  const value = rows[0] ? toAssignment(rows[0]) : null;
  assignmentCache.set(key, { value, at: Date.now() });
  return value;
}

export async function listAssignments(subject: string): Promise<(Assignment & { active: boolean })[]> {
  const { rows } = await pool.query(
    `SELECT a.tenant_id, a.role, a.expires_at, t.name, t.zone,
            (a.expires_at IS NULL OR a.expires_at > now()) AS active
       FROM assignments a JOIN tenants t USING (tenant_id)
      WHERE a.subject = $1 ORDER BY a.tenant_id`,
    [subject],
  );
  return rows.map((r) => ({ ...toAssignment(r), active: r.active }));
}

function toAssignment(r: any): Assignment {
  return { tenantId: r.tenant_id, role: r.role, expiresAt: r.expires_at, tenantName: r.name, zone: r.zone };
}

/** Marks a confirmation id as used. False if it was already used (replay). */
export async function consumeConfirmation(jti: string): Promise<boolean> {
  const { rowCount } = await pool.query("INSERT INTO confirmations_used(id) VALUES ($1) ON CONFLICT DO NOTHING", [jti]);
  return rowCount === 1;
}

export interface AuditRecord {
  requestId: string;
  subject?: string;
  email?: string;
  principalType?: string;
  clientId?: string;
  tenantId?: number;
  tool: string;
  tier?: string;
  argsHash?: string;
  argsRedacted?: unknown;
  confirmationId?: string;
  outcome: "allowed" | "planned" | "denied" | "error";
  reason?: string;
  backendRoutes?: string[];
  latencyMs?: number;
}

export async function writeAudit(r: AuditRecord): Promise<void> {
  // Structured line for the log pipeline, plus the queryable store.
  console.log(JSON.stringify({ type: "audit", mcp_server: config.serverName, ...r }));
  await pool.query(
    `INSERT INTO audit_log(request_id, subject, email, principal_type, client_id, mcp_server, tenant_id, tool, tier,
                           args_hash, args_redacted, confirmation_id, outcome, reason, backend_route, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [r.requestId, r.subject, r.email, r.principalType, r.clientId, config.serverName, r.tenantId ?? null, r.tool, r.tier,
     r.argsHash, r.argsRedacted === undefined ? null : JSON.stringify(r.argsRedacted), r.confirmationId, r.outcome, r.reason,
     r.backendRoutes?.join(", ") || null, r.latencyMs],
  );
}
