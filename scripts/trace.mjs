#!/usr/bin/env node
// Live trace of requests through the stack: APISIX -> MCP server -> backends.
// Every hop logs the gateway's request id, so lines are grouped by that id and
// printed gateway first. A request that reaches the MCP server without a
// gateway id is flagged: it did not come through APISIX.
//
//   make trace            (Ctrl+C to stop)
import { spawn } from "node:child_process";

const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = (s) => c(2, s), bold = (s) => c(1, s), red = (s) => c(31, s), green = (s) => c(32, s), yellow = (s) => c(33, s), cyan = (s) => c(36, s);
const status = (s) => (s >= 500 ? red(s) : s >= 400 ? yellow(s) : green(s));
const upstreamName = (addr) => (addr.endsWith(":3000") ? "mcp-server" : addr.endsWith(":8080") ? "keycloak" : addr === "-" ? null : addr);

// id -> { gateway: string|null, hops: string[], firstSeen }
const pending = new Map();
const WAIT_MS = 4000;

function flush(id, force = false) {
  const g = pending.get(id);
  if (!g || (!g.gateway && !force)) return;
  pending.delete(id);
  console.log(g.gateway ?? red(`✗ NOT SEEN AT GATEWAY  ${id.slice(0, 8)}  (reached a service without an APISIX access log line)`));
  for (const h of g.hops) console.log(h);
}

function add(id, line, isGateway = false) {
  const g = pending.get(id) ?? { gateway: null, hops: [], firstSeen: Date.now() };
  if (isGateway) g.gateway = line; else g.hops.push(line);
  pending.set(id, g);
  if (isGateway) setTimeout(() => flush(id), 300); // let hops for this id arrive, then print
}

setInterval(() => {
  for (const [id, g] of pending) if (Date.now() - g.firstSeen > WAIT_MS) flush(id, true);
}, 1000);

// e.g. 192.168.16.1 - - [25/Sep/2026:10:18:14 +0000] localhost:9080 "POST /mcp HTTP/1.1" 202 5 0.002 "-" "undici" 192.168.16.8:3000 202 0.002 "http://…" "2de5…"
const ACCESS = /^(\S+) - \S+ \[([^\]]+)\] \S+ "(\S+) (\S+) [^"]*" (\d+) \d+ ([\d.]+) "[^"]*" "([^"]*)" (\S+) \S+ \S+ "[^"]*" "([^"]*)"/;

function onLine(service, text) {
  if (service === "apisix") {
    const m = ACCESS.exec(text);
    if (!m) return;
    const [, ip, time, method, uri, st, secs, agent, upstream, id] = m;
    if (uri.startsWith("/apisix/admin") || uri.startsWith("/resources/")) return; // health checks, static files
    const to = upstreamName(upstream);
    const where = to ? `→ ${cyan(to)}` : yellow("stopped at the gateway");
    const clock = time.split(":").slice(1, 4).join(":").split(" ")[0];
    add(id, `${dim(clock)} ${bold("GATEWAY")}  ${dim(id.slice(0, 8))}  ${method} ${uri.split("?")[0]}  ${where}  ${status(+st)}  ${dim(`${Math.round(secs * 1000)} ms, ${ip}, ${agent}`)}`, true);
    return;
  }
  let j;
  try { j = JSON.parse(text); } catch { return; }
  if (service === "mcp-server") {
    if (j.type === "warning") {
      console.log(red(`⚠ DIRECT REQUEST  ${j.method} ${j.path}  did not come through the gateway`));
    } else if (j.type === "http") {
      const what = j.tool ? `tools/call ${bold(j.tool)}` : j.rpc ?? `${j.method} ${j.path}`;
      add(j.request_id, `         ${bold("  MCP")}      ${dim(j.request_id.slice(0, 8))}  ${what}  ${status(j.status)}  ${dim(j.subject ?? "no token")}${j.via_gateway ? "" : red("  (not via gateway)")}`);
    } else if (j.type === "audit") {
      const out = j.outcome === "allowed" ? green(j.outcome) : j.outcome === "planned" ? cyan(j.outcome) : red(j.outcome);
      add(j.requestId, `         ${dim("    audit")}    tenant ${j.tenantId ?? "-"}  ${j.tier}  ${out}${j.reason ? dim(`  ${j.reason}`) : ""}`);
    }
  } else if (j.type === "http" && j.request_id) {
    add(j.request_id, `         ${bold("    BACKEND")}  ${dim(j.request_id.slice(0, 8))}  ${cyan(j.service)} ${j.method} ${j.path}  ${status(j.status)}  ${dim(`tenant ${j.tenant_id ?? "-"}`)}`);
  }
}

console.log(dim("Following apisix, mcp-server, rest-api, portal-api. Use your AI client now; Ctrl+C to stop.\n"));
const p = spawn("docker", ["compose", "logs", "-f", "--no-color", "--since", "1s", "apisix", "mcp-server", "rest-api", "portal-api"], { stdio: ["ignore", "pipe", "inherit"] });
let buf = "";
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = /^([\w-]+?)-\d+\s+\|\s(.*)$/.exec(line);
    if (m) onLine(m[1], m[2]);
  }
});
p.on("exit", (code) => process.exit(code ?? 0));
