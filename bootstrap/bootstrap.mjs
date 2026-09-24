// Configures Keycloak (realm "corp-entra" = mock Entra ID, realm "platform" = the
// Platform authorization server) and syncs the assignment store with
// directory.json. Idempotent: every step creates what is missing and updates
// what exists. Runs on `make up`, `make bootstrap` and whenever PUBLIC_URL changes.
import { readFile } from "node:fs/promises";
import pg from "pg";

const PUBLIC_URL = required("PUBLIC_URL").replace(/\/$/, "");
const KC = required("KEYCLOAK_INTERNAL_URL");
const MCP_URL = `${PUBLIC_URL}/mcp`;
const DEMO_PASSWORD = required("DEMO_PASSWORD");

// Tenants, staff (mock Entra users), their assignments and the hosts that
// self-registered MCP clients may use all come from directory.json, so the
// usual changes are an edit there plus `make bootstrap`.
const directory = JSON.parse(await readFile(process.env.DIRECTORY_FILE ?? "/config/directory.json", "utf8"));
const TENANTS = directory.tenants.map((t) => t.tenant_id);
const STAFF = directory.staff.map((s) => ({ email: `${s.username}@example.com`, groups: [], assignments: [], ...s }));
const TRUSTED_HOSTS = directory.dcrTrustedHosts;
const ROLES = ["viewer", "support_operator", "supervisor", "admin"];

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// --- Keycloak admin client -------------------------------------------------

let token;
async function login() {
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password", client_id: "admin-cli",
      username: "admin", password: required("KEYCLOAK_ADMIN_PASSWORD"),
    }),
  });
  if (!res.ok) throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  token = (await res.json()).access_token;
}

async function api(method, path, body, { allow = [] } = {}) {
  const res = await fetch(`${KC}/admin/realms${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok && !allow.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, location: res.headers.get("location") };
}
const get = (p) => api("GET", p).then((r) => r.data);

async function ensureRealm(realm, settings) {
  const { status } = await api("GET", `/${realm}`, undefined, { allow: [404] });
  if (status === 404) await api("POST", "", { realm, enabled: true });
  await api("PUT", `/${realm}`, { realm, enabled: true, ...settings });
}

async function ensureClient(realm, rep) {
  const [existing] = await get(`/${realm}/clients?clientId=${encodeURIComponent(rep.clientId)}`);
  if (!existing) {
    await api("POST", `/${realm}/clients`, rep);
  } else {
    await api("PUT", `/${realm}/clients/${existing.id}`, { ...existing, ...rep, id: existing.id });
  }
  const [client] = await get(`/${realm}/clients?clientId=${encodeURIComponent(rep.clientId)}`);
  return client;
}

async function setClientScopes(realm, client, kind, names) {
  const scopes = await get(`/${realm}/client-scopes`);
  const current = await get(`/${realm}/clients/${client.id}/${kind}-client-scopes`);
  for (const s of current) {
    if (!names.includes(s.name)) await api("DELETE", `/${realm}/clients/${client.id}/${kind}-client-scopes/${s.id}`);
  }
  for (const name of names) {
    const s = scopes.find((x) => x.name === name);
    if (!s) throw new Error(`client scope ${name} missing`);
    await api("PUT", `/${realm}/clients/${client.id}/${kind}-client-scopes/${s.id}`, undefined, { allow: [409] });
  }
}

async function ensureClientScope(realm, { name, description, attributes, mappers = [] }) {
  const scopes = await get(`/${realm}/client-scopes`);
  let scope = scopes.find((s) => s.name === name);
  const rep = { name, description, protocol: "openid-connect", attributes };
  if (!scope) {
    await api("POST", `/${realm}/client-scopes`, rep);
    scope = (await get(`/${realm}/client-scopes`)).find((s) => s.name === name);
  } else {
    await api("PUT", `/${realm}/client-scopes/${scope.id}`, { ...scope, ...rep });
  }
  // Replace mappers so config changes (e.g. a new PUBLIC_URL) always apply.
  for (const m of await get(`/${realm}/client-scopes/${scope.id}/protocol-mappers/models`)) {
    await api("DELETE", `/${realm}/client-scopes/${scope.id}/protocol-mappers/models/${m.id}`);
  }
  for (const m of mappers) {
    await api("POST", `/${realm}/client-scopes/${scope.id}/protocol-mappers/models`, { protocol: "openid-connect", ...m });
  }
  return scope;
}

async function ensureUser(realm, { username, email, firstName, lastName, attributes, password }) {
  let [user] = await get(`/${realm}/users?username=${username}&exact=true`);
  const rep = { username, email, firstName, lastName, emailVerified: true, attributes, requiredActions: [] };
  const created = !user;
  if (created) {
    // Enabled only on creation, so disabling someone in the console survives re-runs.
    await api("POST", `/${realm}/users`, { ...rep, enabled: true });
    [user] = await get(`/${realm}/users?username=${username}&exact=true`);
  } else {
    await api("PUT", `/${realm}/users/${user.id}`, { ...user, ...rep });
  }
  // Only on creation, so a password changed in the admin console survives re-runs.
  if (password && created) {
    await api("PUT", `/${realm}/users/${user.id}/reset-password`, { type: "password", value: password, temporary: false });
  }
  return user;
}

async function ensureGroup(realm, name) {
  let group = (await get(`/${realm}/groups?search=${name}&exact=true`)).find((g) => g.name === name);
  if (!group) {
    await api("POST", `/${realm}/groups`, { name });
    group = (await get(`/${realm}/groups?search=${name}&exact=true`)).find((g) => g.name === name);
  }
  return group;
}

const audienceMapper = (name, config) => ({
  name, protocolMapper: "oidc-audience-mapper",
  config: { "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true", ...config },
});
const hardcodedClaim = (name, claim, value, type) => ({
  name, protocolMapper: "oidc-hardcoded-claim-mapper",
  config: {
    "claim.name": claim, "claim.value": value, "jsonType.label": type,
    "access.token.claim": "true", "id.token.claim": "false", "userinfo.token.claim": "false", "introspection.token.claim": "true",
  },
});

// --- corp-entra: stand-in for the company's Entra ID ---------------------------

async function configureEntra() {
  await ensureRealm("corp-entra", {
    displayName: "Corporate Entra ID (mock)",
    loginWithEmailAllowed: true,
    registrationAllowed: false,
  });

  const client = await ensureClient("corp-entra", {
    clientId: "platform-keycloak-broker",
    name: "Platform authorization server (Keycloak broker)",
    protocol: "openid-connect",
    publicClient: false,
    clientAuthenticatorType: "client-secret",
    secret: required("ENTRA_BROKER_SECRET"),
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: [`${PUBLIC_URL}/realms/platform/broker/entra/endpoint`],
    webOrigins: [],
    attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": `${PUBLIC_URL}/*` },
  });

  // Entra puts group membership into the id_token; do the same.
  const mappers = await get(`/corp-entra/clients/${client.id}/protocol-mappers/models`);
  if (!mappers.find((m) => m.name === "groups")) {
    await api("POST", `/corp-entra/clients/${client.id}/protocol-mappers/models`, {
      name: "groups", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper",
      config: { "claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true" },
    });
  }

  const ids = {};
  for (const s of STAFF) {
    const user = await ensureUser("corp-entra", {
      username: s.username, email: s.email, firstName: s.firstName, lastName: s.lastName,
      password: s.password ?? DEMO_PASSWORD,
    });
    for (const g of s.groups) {
      const group = await ensureGroup("corp-entra", g);
      await api("PUT", `/corp-entra/users/${user.id}/groups/${group.id}`);
    }
    ids[s.username] = user.id;
  }
  return ids;
}

// --- platform: the Platform authorization server -----------------------------------

async function configurePlatform(entraIds) {
  await ensureRealm("platform", {
    displayName: "Contact Center Platform",
    loginWithEmailAllowed: true,
    registrationAllowed: false,
    accessTokenLifespan: 600, // 10 min
    revokeRefreshToken: true, // rotating refresh tokens
    refreshTokenMaxReuse: 0,
    ssoSessionIdleTimeout: 172800, // survives a 24 h idle
    ssoSessionMaxLifespan: 2592000,
    offlineSessionIdleTimeout: 2592000,
    organizationsEnabled: true,
    eventsEnabled: true,
    eventsExpiration: 7776000, // 90 days
    adminEventsEnabled: true,
    adminEventsDetailsEnabled: true,
  });

  // Keep custom user attributes such as principal_type (KC 26 user profile).
  const profile = await get("/platform/users/profile");
  if (profile.unmanagedAttributePolicy !== "ADMIN_EDIT") {
    await api("PUT", "/platform/users/profile", { ...profile, unmanagedAttributePolicy: "ADMIN_EDIT" });
  }

  // Coarse capabilities the person consents to. Each one also carries the
  // audience binding (RFC 8707 workaround): a token for an MCP client is bound
  // to the canonical MCP URL, and to the MCP server's own client so it can be
  // the subject_token of a standard token exchange. The mappers live on these
  // scopes (not a separate default scope) because a client that registers with
  // an explicit "scope" gets exactly those scopes, as Claude and ChatGPT do.
  const mcpTokenMappers = [
    audienceMapper("mcp-resource", { "included.custom.audience": MCP_URL }),
    audienceMapper("mcp-server-client", { "included.client.audience": "platform-mcp-server" }),
    {
      name: "principal_type", protocolMapper: "oidc-usermodel-attribute-mapper",
      config: { "user.attribute": "principal_type", "claim.name": "principal_type", "jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true" },
    },
    // Person identity for the audit trail, whatever other scopes the client asked for.
    {
      name: "email", protocolMapper: "oidc-usermodel-property-mapper",
      config: { "user.attribute": "email", "claim.name": "email", "jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true" },
    },
    { name: "name", protocolMapper: "oidc-full-name-mapper", config: { "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true" } },
  ];
  const consent = (text) => ({ "include.in.token.scope": "true", "display.on.consent.screen": "true", "consent.screen.text": text });
  await ensureClientScope("platform", {
    name: "platform:read", description: "Read contact-center platform data",
    attributes: consent("Read contact-center platform data in the tenants you are assigned to"),
    mappers: mcpTokenMappers,
  });
  await ensureClientScope("platform", {
    name: "platform:write", description: "Change contact-center platform data",
    attributes: consent("Change contact-center platform data in the tenants you are assigned to (with confirmation)"),
    mappers: mcpTokenMappers,
  });

  // Internal token (token exchange result) for portal-api/rest-api: aud, act and
  // exactly one tenant + role, requested per call by the MCP server.
  await ensureClientScope("platform", {
    name: "backend-audience", description: "Internal token for portal-api/rest-api",
    attributes: { "include.in.token.scope": "false", "display.on.consent.screen": "false" },
    mappers: [
      audienceMapper("platform-backend", { "included.client.audience": "platform-backend" }),
      hardcodedClaim("act", "act", JSON.stringify({ sub: "platform-mcp-server" }), "JSON"),
    ],
  });
  for (const id of TENANTS) {
    await ensureClientScope("platform", {
      name: `tenant-${id}`, description: `Pins the internal token to tenant ${id}`,
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
      mappers: [hardcodedClaim("tenant_id", "tenant_id", String(id), "int")],
    });
  }
  for (const role of ROLES) {
    await ensureClientScope("platform", {
      name: `role-${role}`, description: `Role ${role} in the pinned tenant`,
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
      mappers: [hardcodedClaim("role", "role", role, "String")],
    });
  }

  // Realm defaults, inherited by every dynamically registered MCP client.
  const scopes = await get("/platform/client-scopes");
  const byName = (n) => scopes.find((s) => s.name === n);
  for (const n of ["platform:read", "basic", "profile", "email"]) {
    await api("PUT", `/platform/default-default-client-scopes/${byName(n).id}`, undefined, { allow: [409] });
  }
  for (const n of ["platform:write", "offline_access"]) {
    await api("PUT", `/platform/default-optional-client-scopes/${byName(n).id}`, undefined, { allow: [409] });
  }

  // Audience-only client for portal-api/rest-api.
  await ensureClient("platform", {
    clientId: "platform-backend", name: "portal-api / rest-api (internal)", protocol: "openid-connect",
    publicClient: false, standardFlowEnabled: false, directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false, implicitFlowEnabled: false,
  });

  // The MCP server: confidential, may only do standard token exchange.
  const mcp = await ensureClient("platform", {
    clientId: "platform-mcp-server", name: "Platform MCP server", protocol: "openid-connect",
    publicClient: false, clientAuthenticatorType: "client-secret", secret: required("MCP_TOKEN_EXCHANGE_SECRET"),
    standardFlowEnabled: false, directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    attributes: { "standard.token.exchange.enabled": "true", "access.token.lifespan": "300" },
  });
  await setClientScopes("platform", mcp, "default", ["backend-audience", "basic"]);
  await setClientScopes("platform", mcp, "optional", [...TENANTS.map((t) => `tenant-${t}`), ...ROLES.map((r) => `role-${r}`)]);

  // Staff log in through (mock) Entra; Keycloak brokers.
  const idp = {
    alias: "entra", displayName: "Corporate Entra ID", providerId: "oidc", enabled: true,
    trustEmail: true, storeToken: false, firstBrokerLoginFlowAlias: "first broker login",
    config: {
      clientId: "platform-keycloak-broker", clientSecret: required("ENTRA_BROKER_SECRET"), clientAuthMethod: "client_secret_post",
      authorizationUrl: `${PUBLIC_URL}/realms/corp-entra/protocol/openid-connect/auth`,
      tokenUrl: `${KC}/realms/corp-entra/protocol/openid-connect/token`,
      jwksUrl: `${KC}/realms/corp-entra/protocol/openid-connect/certs`,
      userInfoUrl: `${KC}/realms/corp-entra/protocol/openid-connect/userinfo`,
      issuer: `${PUBLIC_URL}/realms/corp-entra`,
      useJwksUrl: "true", validateSignature: "true", pkceEnabled: "true", pkceMethod: "S256",
      defaultScope: "openid email profile", syncMode: "FORCE",
    },
  };
  const { status } = await api("GET", "/platform/identity-provider/instances/entra", undefined, { allow: [404] });
  if (status === 404) await api("POST", "/platform/identity-provider/instances", idp);
  else await api("PUT", "/platform/identity-provider/instances/entra", idp);

  const idpMappers = await get("/platform/identity-provider/instances/entra/mappers");
  if (!idpMappers.find((m) => m.name === "principal_type")) {
    await api("POST", "/platform/identity-provider/instances/entra/mappers", {
      name: "principal_type", identityProviderAlias: "entra", identityProviderMapper: "hardcoded-attribute-idp-mapper",
      config: { syncMode: "INHERIT", attribute: "principal_type", "attribute.value": "staff" },
    });
  }

  // Skip the login form and go straight to Entra, as staff would.
  const executions = await get("/platform/authentication/flows/browser/executions");
  const redirector = executions.find((e) => e.providerId === "identity-provider-redirector");
  if (redirector && !redirector.authenticationConfig) {
    await api("POST", `/platform/authentication/executions/${redirector.id}/config`, {
      alias: "entra-default", config: { defaultProvider: "entra" },
    });
  }

  // Staff users exist up front, already linked to their Entra identity, so the
  // assignment store can be keyed on the Platform subject from day one.
  const subjects = {};
  for (const s of STAFF) {
    const user = await ensureUser("platform", {
      username: s.username, email: s.email, firstName: s.firstName, lastName: s.lastName,
      attributes: { principal_type: ["staff"] },
    });
    const links = await get(`/platform/users/${user.id}/federated-identity`);
    if (!links.find((l) => l.identityProvider === "entra")) {
      await api("POST", `/platform/users/${user.id}/federated-identity/entra`, {
        identityProvider: "entra", userId: entraIds[s.username], userName: s.username,
      });
    }
    subjects[s.username] = user.id;
  }

  // One Organization per tenant later; Example Corp staff are their own org now.
  const orgs = await get("/platform/organizations?search=Example%20Corp&exact=true");
  let org = orgs.find((o) => o.alias === "example-corp");
  if (!org) {
    await api("POST", "/platform/organizations", {
      name: "Example Corp", alias: "example-corp", enabled: true,
      domains: [{ name: "example.com", verified: true }],
    });
    org = (await get("/platform/organizations?search=Example%20Corp&exact=true")).find((o) => o.alias === "example-corp");
  }
  const orgIdps = await get(`/platform/organizations/${org.id}/identity-providers`);
  if (!orgIdps.find((i) => i.alias === "entra")) {
    await api("POST", `/platform/organizations/${org.id}/identity-providers`, "entra");
  }
  for (const id of Object.values(subjects)) {
    await api("POST", `/platform/organizations/${org.id}/members`, id, { allow: [409] });
  }

  await configureRegistrationPolicies();
  return subjects;
}

// Anonymous DCR, restricted by policy (rate-limited at APISIX too).
async function configureRegistrationPolicies() {
  const type = "org.keycloak.services.clientregistration.policy.ClientRegistrationPolicy";
  const policies = await get(`/platform/components?type=${type}`);
  const anon = (providerId) => policies.find((p) => p.providerId === providerId && p.subType === "anonymous");

  const trusted = anon("trusted-hosts");
  await api("PUT", `/platform/components/${trusted.id}`, {
    ...trusted,
    config: {
      "host-sending-registration-request-must-match": ["false"], // Claude/ChatGPT register from their cloud
      "client-uris-must-match": ["true"], // but redirect URIs must be on these hosts
      "trusted-hosts": TRUSTED_HOSTS,
    },
  });

  const allowedScopes = anon("allowed-client-templates");
  await api("PUT", `/platform/components/${allowedScopes.id}`, {
    ...allowedScopes,
    config: { "allow-default-scopes": ["true"], "allowed-client-scopes": ["platform:read", "platform:write", "offline_access"] },
  });

  const max = anon("max-clients");
  await api("PUT", `/platform/components/${max.id}`, { ...max, config: { "max-clients": ["200"] } });
}

// --- Assignment store --------------------------------------------------------

// Makes the store match directory.json: tenants are upserted (never deleted,
// the audit log refers to them), and each listed person's assignments become
// exactly the ones in the file. People not in the file are left alone.
async function syncDirectory(subjects) {
  const db = new pg.Client({ connectionString: required("DATABASE_URL") });
  await db.connect();
  try {
    await db.query("BEGIN");
    for (const t of directory.tenants) {
      await db.query(
        `INSERT INTO tenants(tenant_id, name, zone) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name, zone = EXCLUDED.zone`,
        [t.tenant_id, t.name, t.zone],
      );
    }
    for (const s of STAFF) {
      const subject = subjects[s.username];
      await db.query(
        `INSERT INTO principals(subject, username, email, principal_type) VALUES ($1, $2, $3, 'staff')
         ON CONFLICT (subject) DO UPDATE SET username = EXCLUDED.username, email = EXCLUDED.email`,
        [subject, s.username, s.email],
      );
      for (const a of s.assignments) {
        await db.query(
          `INSERT INTO assignments(subject, tenant_id, role, expires_at, assigned_by, reason)
           VALUES ($1, $2, $3, $4, 'directory.json', $5)
           ON CONFLICT (subject, tenant_id) DO UPDATE
             SET role = EXCLUDED.role, expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason
             WHERE (assignments.role, assignments.expires_at, assignments.reason)
                   IS DISTINCT FROM (EXCLUDED.role, EXCLUDED.expires_at, EXCLUDED.reason)`,
          [subject, a.tenant_id, a.role, a.expires_at ?? null, a.reason ?? "directory.json"],
        );
      }
      await db.query(
        "DELETE FROM assignments WHERE subject = $1 AND NOT (tenant_id = ANY($2::int[]))",
        [subject, s.assignments.map((a) => a.tenant_id)],
      );
    }
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}

// The master realm (admin console login) is only served on the local-only
// port, never through APISIX, so it gets its own frontend URL.
async function configureMaster() {
  const master = await get("/master");
  const frontendUrl = process.env.KEYCLOAK_ADMIN_URL ?? "http://localhost:8081";
  if (master.attributes?.frontendUrl !== frontendUrl) {
    await api("PUT", "/master", { realm: "master", attributes: { ...master.attributes, frontendUrl } });
    await login(); // the admin token's issuer changed with the frontend URL
  }
}

await login();
await configureMaster();
const entraIds = await configureEntra();
const subjects = await configurePlatform(entraIds);
await syncDirectory(subjects);
console.log(JSON.stringify({ ok: true, issuer: `${PUBLIC_URL}/realms/platform`, mcp: MCP_URL, subjects }));
