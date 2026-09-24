import { z, type ZodRawShape } from "zod";
import type { Principal } from "./auth.js";
import type { BackendClient } from "./backend.js";
import type { Tier } from "./guards.js";
import type { Role, Tenant } from "./store.js";
import { listAssignments } from "./store.js";
import { config } from "./config.js";

export interface ToolContext {
  principal: Principal;
  tenant?: Tenant;
  role?: Role;
  backend?: BackendClient;
}

export interface Plan {
  summary: string;
  effect: string;
  objects?: unknown;
  count?: number;
  estimatedCost?: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  tier: Tier;
  scope: "platform:read" | "platform:write";
  /** Minimum role in the tenant; ignored for tools with tenant: "none". */
  minRole: Role;
  tenant: "required" | "optional" | "none";
  input: ZodRawShape;
  openWorld?: boolean;
  idempotent?: boolean;
  /** T2/T3 only: describe what execute would do. May read the backend. */
  plan?: (ctx: Required<Pick<ToolContext, "backend" | "tenant">> & ToolContext, args: any) => Promise<Plan>;
  run: (ctx: ToolContext, args: any) => Promise<unknown>;
}

const id = z.number().int().positive();

// One task per tool, explicit tenant_id, capped result sizes. Backends are
// the mock portal-api and rest-api services; paths mirror the real routes.
export const TOOLS: ToolDef[] = [
  {
    name: "get_my_context",
    title: "My access context",
    description:
      "Who you are, which contact-center platform tenants you are assigned to with which role, and which of them this MCP server's zone serves. " +
      "Pass tenant_id to also get that tenant's configuration. Call this first to find valid tenant_id values.",
    tier: "T0", scope: "platform:read", minRole: "viewer", tenant: "optional", input: {},
    run: async (ctx) => {
      const assignments = await listAssignments(ctx.principal.subject);
      return {
        you: { subject: ctx.principal.subject, email: ctx.principal.email, name: ctx.principal.name, principal_type: ctx.principal.principalType, client: ctx.principal.clientId },
        scopes: [...ctx.principal.scopes].filter((s) => s.startsWith("platform:")),
        mcp_server: { name: config.serverName, zone: config.zone },
        assignments: assignments.map((a) => ({
          tenant_id: a.tenantId, tenant: a.tenantName, role: a.role, zone: a.zone,
          expires_at: a.expiresAt, active: a.active, served_here: a.zone === config.zone,
        })),
        tenant_config: ctx.backend ? await ctx.backend.call("portal-api", "GET", "/client/config") : undefined,
      };
    },
  },
  {
    name: "list_skills",
    title: "List skills",
    description: "List contact-center skills (queues) in a tenant with channel, agent count and current queue length.",
    tier: "T0", scope: "platform:read", minRole: "viewer", tenant: "required", input: {},
    run: (ctx) => ctx.backend!.call("rest-api", "GET", "/skill"),
  },
  {
    name: "get_skill_schedule",
    title: "Skill opening hours",
    description: "Get the weekly opening schedule of one skill.",
    tier: "T0", scope: "platform:read", minRole: "viewer", tenant: "required",
    input: { skill_id: id.describe("Skill id from list_skills") },
    run: (ctx, a) => ctx.backend!.call("rest-api", "GET", `/skill/${a.skill_id}/schedule`),
  },
  {
    name: "get_realtime_stats",
    title: "Realtime stats",
    description: "Current agents online and contacts waiting in a tenant, per skill.",
    tier: "T0", scope: "platform:read", minRole: "viewer", tenant: "required", input: {},
    run: (ctx) => ctx.backend!.call("portal-api", "GET", "/stats/global"),
  },
  {
    name: "list_campaigns",
    title: "List campaigns",
    description: "List campaigns in a tenant with status and type.",
    tier: "T0", scope: "platform:read", minRole: "viewer", tenant: "required", input: {},
    run: (ctx) => ctx.backend!.call("portal-api", "GET", "/campaign"),
  },
  {
    name: "get_campaign_stats",
    title: "Campaign stats",
    description: "Contacts, reached, converted and conversion rate for one campaign.",
    tier: "T0", scope: "platform:read", minRole: "viewer", tenant: "required",
    input: { campaign_id: id.describe("Campaign id from list_campaigns") },
    run: (ctx, a) => ctx.backend!.call("portal-api", "GET", `/campaign/${a.campaign_id}/stats`),
  },
  {
    name: "list_segments",
    title: "List segments",
    description: "List customer segments in a tenant with their rule and size.",
    tier: "T0", scope: "platform:read", minRole: "viewer", tenant: "required", input: {},
    run: (ctx) => ctx.backend!.call("rest-api", "GET", "/segment"),
  },
  {
    name: "search_customers",
    title: "Search customers",
    description: "Search customer profiles by name, email or phone (personal data; max 50 rows).",
    tier: "T1", scope: "platform:read", minRole: "support_operator", tenant: "required",
    input: {
      q: z.string().min(2).describe("Name, email or phone fragment"),
      limit: z.number().int().min(1).max(50).default(20),
    },
    run: (ctx, a) => ctx.backend!.call("rest-api", "GET", `/customers?q=${encodeURIComponent(a.q)}&limit=${a.limit}`),
  },
  {
    name: "get_customer_profile",
    title: "Customer profile",
    description: "Get one customer profile (personal data).",
    tier: "T1", scope: "platform:read", minRole: "support_operator", tenant: "required",
    input: { customer_id: z.string().describe("Customer id, e.g. c-1") },
    run: (ctx, a) => ctx.backend!.call("rest-api", "GET", `/customers/${encodeURIComponent(a.customer_id)}`),
  },
  {
    name: "get_lead",
    title: "Get lead",
    description: "Get one lead (personal data).",
    tier: "T1", scope: "platform:read", minRole: "support_operator", tenant: "required",
    input: { lead_id: z.string().describe("Lead id, e.g. l-900") },
    run: (ctx, a) => ctx.backend!.call("rest-api", "GET", `/leads/${encodeURIComponent(a.lead_id)}`),
  },
  {
    name: "create_lead",
    title: "Create lead",
    description: "Create a new lead in a tenant. Two steps: the first call returns a plan and a confirmation_id; call again with it to execute.",
    tier: "T2", scope: "platform:write", minRole: "support_operator", tenant: "required",
    input: {
      name: z.string().min(1),
      phone: z.string().min(6).describe("E.164 phone number"),
      email: z.string().email().optional(),
      notes: z.string().max(500).optional(),
    },
    plan: async (ctx, a) => ({ summary: `Create lead "${a.name}" in ${ctx.tenant.name}`, effect: "One new lead with status 'new' and source 'mcp'.", count: 1 }),
    run: (ctx, a) => ctx.backend!.call("rest-api", "POST", "/form2lead", { name: a.name, phone: a.phone, email: a.email, notes: a.notes }),
  },
  {
    name: "upsert_segment",
    title: "Create or update segment",
    description: "Create a segment, or update an existing one when id is given. Two steps: plan, then execute with confirmation_id.",
    tier: "T2", scope: "platform:write", minRole: "support_operator", tenant: "required", idempotent: true,
    input: {
      id: z.string().optional().describe("Existing segment id to update; omit to create"),
      name: z.string().min(1),
      rule: z.string().min(1).describe("Segment rule, e.g. lifetime_value > 5000"),
    },
    plan: async (ctx, a) => {
      const segments = await ctx.backend.call<any[]>("rest-api", "GET", "/segment");
      const existing = a.id ? segments.find((s) => s.id === a.id) : undefined;
      return existing
        ? { summary: `Update segment ${a.id} in ${ctx.tenant.name}`, effect: `Rule "${existing.rule}" becomes "${a.rule}", name "${existing.name}" becomes "${a.name}".`, objects: existing, count: 1 }
        : { summary: `Create segment "${a.name}" in ${ctx.tenant.name}`, effect: `New segment with rule "${a.rule}".`, count: 1 };
    },
    run: (ctx, a) => ctx.backend!.call("rest-api", "POST", "/segment", a),
  },
  {
    name: "update_tenant_setting",
    title: "Update tenant setting",
    description: "Change one tenant setting (see get_my_context tenant_config.settings). Two steps: plan, then execute with confirmation_id.",
    tier: "T2", scope: "platform:write", minRole: "supervisor", tenant: "required",
    input: { key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) },
    plan: async (ctx, a) => {
      const cfg = await ctx.backend.call<any>("portal-api", "GET", "/client/config");
      return { summary: `Set ${a.key} in ${ctx.tenant.name}`, effect: `${a.key}: ${JSON.stringify(cfg.settings?.[a.key])} -> ${JSON.stringify(a.value)}`, count: 1 };
    },
    run: (ctx, a) => ctx.backend!.call("portal-api", "PUT", `/client/settings/${encodeURIComponent(a.key)}`, { value: a.value }),
  },
  {
    name: "start_campaign",
    title: "Start campaign",
    description: "Start (or resume) a campaign; it will contact real customers. Two steps: plan, then execute with confirmation_id after the user explicitly agrees.",
    tier: "T3", scope: "platform:write", minRole: "supervisor", tenant: "required", openWorld: true,
    input: { campaign_id: id },
    plan: async (ctx, a) => {
      const s = await ctx.backend.call<any>("portal-api", "GET", `/campaign/${a.campaign_id}/stats`);
      const remaining = s.contacts - s.reached;
      return {
        summary: `Start campaign ${a.campaign_id} in ${ctx.tenant.name}`,
        effect: `Begins contacting up to ${remaining} customers not yet reached.`,
        count: remaining,
        estimatedCost: `~EUR ${(remaining * 0.04).toFixed(2)} at EUR 0.04 per contact`,
      };
    },
    run: (ctx, a) => ctx.backend!.call("portal-api", "POST", `/campaign/${a.campaign_id}/start`),
  },
  {
    name: "pause_campaign",
    title: "Pause campaign",
    description: "Pause a running campaign. Two steps: plan, then execute with confirmation_id.",
    tier: "T3", scope: "platform:write", minRole: "supervisor", tenant: "required",
    input: { campaign_id: id },
    plan: async (ctx, a) => ({ summary: `Pause campaign ${a.campaign_id} in ${ctx.tenant.name}`, effect: "Stops new contact attempts until started again.", count: 1 }),
    run: (ctx, a) => ctx.backend!.call("portal-api", "POST", `/campaign/${a.campaign_id}/pause`),
  },
  {
    name: "add_to_blacklist",
    title: "Blacklist a phone number",
    description: "Add a phone number to the tenant's do-not-contact list. Two steps: plan, then execute with confirmation_id after the user explicitly agrees.",
    tier: "T3", scope: "platform:write", minRole: "supervisor", tenant: "required",
    input: { phone: z.string().min(6), reason: z.string().min(3) },
    plan: async (ctx, a) => ({ summary: `Blacklist ${a.phone} in ${ctx.tenant.name}`, effect: "The number will no longer be called or messaged by any campaign.", count: 1 }),
    run: (ctx, a) => ctx.backend!.call("rest-api", "POST", "/blacklists", a),
  },
  {
    name: "send_sms",
    title: "Send SMS",
    description: "Send one SMS from the tenant's sender id to a customer. Costs money and reaches a real person. Two steps: plan, then execute with confirmation_id after the user explicitly agrees.",
    tier: "T3", scope: "platform:write", minRole: "supervisor", tenant: "required", openWorld: true,
    input: { to: z.string().min(6).describe("E.164 phone number"), text: z.string().min(1).max(640) },
    plan: async (ctx, a) => {
      const parts = Math.ceil(a.text.length / 160);
      return { summary: `Send SMS to ${a.to} from ${ctx.tenant.name}`, effect: `${parts} SMS part(s) delivered to ${a.to}.`, count: 1, estimatedCost: `~EUR ${(parts * 0.05).toFixed(2)}` };
    },
    run: (ctx, a) => ctx.backend!.call("rest-api", "POST", "/sms/send", { to: a.to, text: a.text }),
  },
];
