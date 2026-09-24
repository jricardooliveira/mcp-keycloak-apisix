import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthError, bearerChallenge, verifyAccessToken, type Principal } from "./auth.js";
import { BackendError, backendClient, internalToken } from "./backend.js";
import { config } from "./config.js";
import { checkRateLimit, hashArgs, issueConfirmation, redactArgs, verifyConfirmation } from "./guards.js";
import { consumeConfirmation, getAssignment, getTenant, roleRank, writeAudit, type AuditRecord } from "./store.js";
import { TOOLS, type ToolContext, type ToolDef } from "./tools.js";

class Denied extends Error {}

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError && { isError: true }),
});

// --- Per-call authorization -------------------------------------------------------
// Order: token (already validated) -> tenant -> assignment + role -> scope ->
// risk tier (rate limit, confirmation) -> token exchange -> backend. Any
// failure stops the call and is audited.

async function invoke(tool: ToolDef, principal: Principal, rawArgs: Record<string, any>): Promise<CallToolResult> {
  const started = Date.now();
  const { confirmation_id: confirmationId, ...args } = rawArgs;
  const audit: AuditRecord = {
    requestId: randomUUID(), subject: principal.subject, email: principal.email, principalType: principal.principalType,
    clientId: principal.clientId, tool: tool.name, tier: tool.tier, tenantId: args.tenant_id,
    argsHash: hashArgs(args), argsRedacted: redactArgs(args), confirmationId: confirmationId?.slice(0, 16), outcome: "denied",
  };
  const ctx: ToolContext = { principal };

  try {
    if (!principal.scopes.has(tool.scope)) throw new Denied(`missing scope ${tool.scope}`);

    const tenantId: number | undefined = args.tenant_id;
    if (tool.tenant === "required" && tenantId === undefined) throw new Denied("tenant_id is required");
    if (tenantId !== undefined) {
      const tenant = await getTenant(tenantId);
      if (!tenant) throw new Denied(`unknown tenant ${tenantId}`);
      if (tenant.zone !== config.zone) {
        throw new Denied(`tenant ${tenantId} (${tenant.name}) is served by zone ${tenant.zone}; use the mcp${tenant.zone} server`);
      }
      // A client company's users only ever work in their own company's tenant,
      // whatever the assignment store says.
      if (principal.principalType === "customer_user" && (!tenant.company || tenant.company !== principal.company)) {
        throw new Denied(`tenant ${tenantId} (${tenant.name}) belongs to another company; you can only work in your own company's tenant`);
      }
      const assignment = await getAssignment(principal.subject, tenantId);
      if (!assignment) throw new Denied(`no active assignment to tenant ${tenantId}`);
      if (roleRank(assignment.role) < roleRank(tool.minRole)) {
        throw new Denied(`role ${assignment.role} in tenant ${tenantId} is below the required ${tool.minRole}`);
      }
      ctx.tenant = tenant;
      ctx.role = assignment.role;
      ctx.backend = backendClient(() => internalToken(principal.subject, principal.accessToken, tenantId, assignment.role), tenantId);
    }

    const limited = await checkRateLimit(principal.subject, tenantId ?? "none", tool.tier);
    if (limited) throw new Denied(limited);

    if (tool.plan) {
      if (!confirmationId) {
        const plan = await tool.plan(ctx as any, args);
        const confirmation = issueConfirmation(principal.subject, tenantId!, tool.name, audit.argsHash!);
        Object.assign(audit, { outcome: "planned", confirmationId: confirmation.id.slice(0, 16), backendRoutes: ctx.backend?.routes });
        return text({
          status: "confirmation_required",
          tenant: `${ctx.tenant!.name} (tenant ${tenantId})`,
          ...plan,
          confirmation_id: confirmation.id,
          expires_at: confirmation.expiresAt,
          next_step:
            (tool.tier === "T3" ? "Restate this plan to the user in your own words and get their explicit yes. " : "") +
            `Then call ${tool.name} again with exactly the same arguments plus confirmation_id.`,
        });
      }
      let jti: string;
      try {
        jti = verifyConfirmation(confirmationId, principal.subject, tenantId!, tool.name, audit.argsHash!);
      } catch (e) {
        throw new Denied((e as Error).message);
      }
      if (!(await consumeConfirmation(jti))) throw new Denied("confirmation_id already used");
      audit.confirmationId = confirmationId.slice(0, 16);
    }

    const result = await tool.run(ctx, args);
    Object.assign(audit, { outcome: "allowed", backendRoutes: ctx.backend?.routes });
    return text(result);
  } catch (e) {
    if (e instanceof Denied) {
      audit.reason = e.message;
      return text(`Denied: ${e.message}`, true);
    }
    Object.assign(audit, { outcome: "error", reason: (e as Error).message, backendRoutes: ctx.backend?.routes });
    if (e instanceof BackendError) return text(`Backend error (${e.status}): ${e.message}`, true);
    console.error(e);
    return text("Internal error; the call was not completed.", true);
  } finally {
    audit.latencyMs = Date.now() - started;
    writeAudit(audit).catch((err) => console.error("audit write failed", err));
  }
}

// --- MCP server per request (stateless) ----------------------------------------------

function buildServer(principal: Principal): McpServer {
  const server = new McpServer(
    { name: config.serverName, title: "CoreCenas Contact Center", version: "0.1.0" },
    {
      instructions:
        "Tools act on CoreCenas contact-center tenants (one per client company). Call get_my_context first to see which tenant_id values you may use. " +
        "Every tenant tool needs an explicit tenant_id. Write tools run in two steps: the first call returns a plan and a confirmation_id; " +
        "show the plan to the user and only call again with confirmation_id once they agree.",
    },
  );

  // tools/list is filtered by scope: a read-only token never sees write tools.
  for (const tool of TOOLS.filter((t) => principal.scopes.has(t.scope))) {
    const shape: Record<string, z.ZodTypeAny> = {};
    if (tool.tenant !== "none") {
      const w = z.number().int().positive().describe("Tenant id; see get_my_context");
      shape.tenant_id = tool.tenant === "required" ? w : w.optional();
    }
    Object.assign(shape, tool.input);
    if (tool.tier === "T1") shape.purpose = z.string().min(5).describe("Why you need this personal data (recorded in the audit log)");
    if (tool.plan) shape.confirmation_id = z.string().optional().describe("Omit on the first call; pass the id returned by the plan to execute");

    const readOnly = tool.tier === "T0" || tool.tier === "T1";
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description} [risk tier ${tool.tier}]`,
        inputSchema: shape,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: tool.tier === "T3",
          idempotentHint: readOnly || !!tool.idempotent,
          openWorldHint: !!tool.openWorld,
        },
      },
      (args) => invoke(tool, principal, args as Record<string, any>),
    );
  }
  return server;
}

// --- HTTP ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true, server: config.serverName }));

// RFC 9728 Protected Resource Metadata, at both well-known paths.
const prm = {
  resource: config.resource,
  authorization_servers: [config.issuer],
  scopes_supported: config.scopesSupported,
  bearer_methods_supported: ["header"],
  resource_name: `CoreCenas Contact Center (${config.zone})`,
};
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => res.json(prm));

async function authenticate(req: Request, res: Response): Promise<Principal | null> {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    res.status(401).set("WWW-Authenticate", bearerChallenge()).json({ error: "unauthorized", error_description: "Bearer token required" });
    return null;
  }
  try {
    return await verifyAccessToken(token);
  } catch (e) {
    const msg = e instanceof AuthError ? e.message : "invalid token";
    res.status(401).set("WWW-Authenticate", bearerChallenge({ error: "invalid_token", error_description: msg })).json({ error: "invalid_token", error_description: msg });
    return null;
  }
}

app.post("/mcp", async (req, res) => {
  const principal = await authenticate(req, res);
  if (!principal) return;

  // Step-up: calling a known tool without its scope -> 403 insufficient_scope.
  const calls = (Array.isArray(req.body) ? req.body : [req.body]).filter((m: any) => m?.method === "tools/call");
  for (const call of calls) {
    const tool = TOOLS.find((t) => t.name === call.params?.name);
    if (tool && !principal.scopes.has(tool.scope)) {
      const scope = [...new Set([...principal.scopes].filter((s) => s.startsWith("platform:")).concat(tool.scope))].join(" ");
      res.status(403).set("WWW-Authenticate", bearerChallenge({ error: "insufficient_scope", scope, error_description: `${tool.name} needs ${tool.scope}` }))
        .json({ error: "insufficient_scope", error_description: `${tool.name} needs ${tool.scope}` });
      return;
    }
  }

  const server = buildServer(principal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// Stateless server: no SSE stream and no sessions to delete.
app.all("/mcp", async (req, res) => {
  if (!(await authenticate(req, res))) return;
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.listen(config.port, () => console.log(`${config.serverName} listening on :${config.port}; resource ${config.resource}`));
