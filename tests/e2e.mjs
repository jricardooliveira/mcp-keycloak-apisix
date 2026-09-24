// End-to-end smoke test acting like an MCP client (Claude / ChatGPT):
// 401 challenge -> protected resource metadata -> AS metadata -> dynamic client
// registration -> PKCE authorization (brokered login at mock Entra + consent)
// -> token -> MCP calls exercising tenant isolation, roles and confirmation.
//
//   node tests/e2e.mjs [username] [password]      (defaults: alice / Passw0rd!)
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const MCP = process.env.MCP_URL ?? "http://localhost:9080/mcp";
const [username = "alice", password = "Passw0rd!"] = process.argv.slice(2);
const REDIRECT = "http://localhost:33418/callback";

// Minimal path-aware cookie jar (both realms set AUTH_SESSION_ID on their own path).
const cookies = new Map();
async function http(url, opts = {}) {
  const path = new URL(url).pathname;
  const send = [...cookies.values()].filter((c) => path.startsWith(c.path)).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(url, { redirect: "manual", ...opts, headers: { ...opts.headers, cookie: send } });
  for (const raw of res.headers.getSetCookie()) {
    const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
    const i = pair.indexOf("=");
    const cookiePath = attrs.find((a) => /^path=/i.test(a))?.slice(5) || "/";
    const c = { name: pair.slice(0, i), value: pair.slice(i + 1), path: cookiePath };
    const key = `${c.name}|${c.path}`;
    if (/max-age=0/i.test(raw) || !c.value) cookies.delete(key);
    else cookies.set(key, c);
  }
  return res;
}
const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });
const decode = (s) => s.replace(/&amp;/g, "&");
const step = (msg) => console.log(`\n== ${msg}`);

// 1. Challenge and discovery
step("401 challenge");
let res = await http(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert.equal(res.status, 401);
const challenge = res.headers.get("www-authenticate");
console.log(challenge);
const prmUrl = challenge.match(/resource_metadata="([^"]+)"/)[1];
// E2E_SCOPE=platform:read exercises a read-only token (write tools hidden, 403 step-up).
const scope = process.env.E2E_SCOPE ?? challenge.match(/scope="([^"]+)"/)[1];
const prm = await (await http(prmUrl)).json();
const asUrl = new URL(prm.authorization_servers[0]);
const meta = await (await http(`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`)).json();
assert.equal(meta.issuer, prm.authorization_servers[0]);
console.log({ resource: prm.resource, issuer: meta.issuer });

// 2. Dynamic client registration
step("dynamic client registration");
res = await http(meta.registration_endpoint, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "e2e smoke test", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none", scope,
  }),
});
const client = await res.json();
assert.equal(res.status, 201, JSON.stringify(client));
console.log({ client_id: client.client_id });

// 3. Authorization code + PKCE, brokered through mock Entra, with consent
step(`authorize as ${username} (PKCE S256, resource indicator)`);
const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(8).toString("hex");
const authz = new URL(meta.authorization_endpoint);
authz.search = new URLSearchParams({
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope, state, resource: prm.resource,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
}).toString();

let url = authz.toString();
let callback;
for (let hops = 0; hops < 20 && !callback; hops++) {
  res = await http(url);
  if (res.status >= 300 && res.status < 400) {
    url = new URL(res.headers.get("location"), url).toString();
    if (url.startsWith(REDIRECT)) callback = new URL(url);
    continue;
  }
  const html = await res.text();
  const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1];
  if (!action) throw new Error(`unexpected page at ${url}: ${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600)}`);
  if (html.includes('name="password"')) {
    console.log("login page:", new URL(url).pathname.split("/protocol")[0]);
    res = await http(new URL(decode(action), url).toString(), form({ username, password }));
  } else if (html.includes('name="accept"')) {
    console.log("consent page:", [...html.matchAll(/<li[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g)].map((m) => m[1].trim()).join(" | "));
    res = await http(new URL(decode(action), url).toString(), form({ accept: "Yes" }));
  } else {
    throw new Error(`unknown form at ${url}`);
  }
  if (res.status >= 300 && res.status < 400) {
    url = new URL(res.headers.get("location"), url).toString();
    if (url.startsWith(REDIRECT)) callback = new URL(url);
  } else {
    throw new Error(`form post returned ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
}
assert.ok(callback, "never reached the redirect_uri");
assert.equal(callback.searchParams.get("state"), state);
assert.equal(callback.searchParams.get("iss"), meta.issuer, "RFC 9207 iss");

step("token");
res = await http(meta.token_endpoint, form({
  grant_type: "authorization_code", code: callback.searchParams.get("code"), redirect_uri: REDIRECT,
  client_id: client.client_id, code_verifier: verifier, resource: prm.resource,
}));
const tokens = await res.json();
assert.equal(res.status, 200, JSON.stringify(tokens));
const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
console.log({ aud: claims.aud, scope: claims.scope, principal_type: claims.principal_type, expires_in: tokens.expires_in, refresh: !!tokens.refresh_token });

// 4. MCP
let id = 0;
async function rpc(method, params, token = tokens.access_token) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await r.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.content[0].text;
  return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};

step("initialize + tools/list");
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
console.log(init.serverInfo, "protocol", init.protocolVersion);
const { tools } = await rpc("tools/list", {});
console.log(tools.map((t) => `${t.name}`).join(", "));

if (!claims.scope.split(" ").includes("platform:write")) {
  step("read-only token: step-up");
  assert.ok(!tools.some((t) => t.name === "start_campaign"), "write tools must be hidden");
  const r = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "start_campaign", arguments: { tenant_id: 1001, campaign_id: 501 } } }),
  });
  console.log(r.status, r.headers.get("www-authenticate"));
  assert.equal(r.status, 403);
}

step("get_my_context");
const me = await call("get_my_context", {});
console.log(me.json.assignments);

const show = async (label, name, args) => {
  const r = await call(name, args);
  console.log(`${r.isError ? "✗" : "✓"} ${label}: ${r.text.replace(/\s+/g, " ").slice(0, 160)}`);
  return r;
};

step("authorization checks");
await show("T0 read in assigned tenant 1001", "list_campaigns", { tenant_id: 1001 });
await show("T1 PII read (purpose recorded)", "search_customers", { tenant_id: 1001, q: "maria", purpose: "Check VIP segment membership" });
await show("tenant in another zone (2001)", "list_campaigns", { tenant_id: 2001 });
await show("unassigned / unknown tenant 9999", "list_campaigns", { tenant_id: 9999 });

const canWrite = claims.scope.split(" ").includes("platform:write");
if (canWrite) step("plan -> execute (T3)");
const plan = canWrite && await show("start_campaign plan", "start_campaign", { tenant_id: 1001, campaign_id: 501 });
if (plan?.json?.confirmation_id) {
  const cid = plan.json.confirmation_id;
  await show("execute with different args", "start_campaign", { tenant_id: 1001, campaign_id: 502, confirmation_id: cid });
  await show("execute", "start_campaign", { tenant_id: 1001, campaign_id: 501, confirmation_id: cid });
  await show("replay", "start_campaign", { tenant_id: 1001, campaign_id: 501, confirmation_id: cid });
}

step("refresh token rotation");
res = await http(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id, resource: prm.resource }));
const refreshed = await res.json();
console.log({ status: res.status, new_refresh_token: refreshed.refresh_token !== tokens.refresh_token });
res = await http(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }));
console.log({ reuse_of_old_refresh_token: res.status, error: (await res.json()).error });

console.log("\nOK");
