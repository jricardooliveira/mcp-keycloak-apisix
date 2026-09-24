// Configures Keycloak and syncs the assignment store with directory.json:
// - realm "platform": the authorization server the AI clients talk to
// - one mock SSO realm per company (CoreCenas staff, MasIkea, VodaFundas),
//   brokered by "platform" and picked by the user's email domain
// Idempotent: every step creates what is missing and updates what exists.
// Runs on `make up`, `make bootstrap` and whenever PUBLIC_URL changes.
import { readFile } from "node:fs/promises";
import pg from "pg";

const PUBLIC_URL = required("PUBLIC_URL").replace(/\/$/, "");
const KC = required("KEYCLOAK_INTERNAL_URL");
const MCP_URL = `${PUBLIC_URL}/mcp`;
const DEMO_PASSWORD = required("DEMO_PASSWORD");

// Companies (and their SSO), tenants, people and their assignments, and the
// hosts that self-registered MCP clients may use all come from directory.json,
// so the usual changes are an edit there plus `make bootstrap`.
const directory = JSON.parse(await readFile(process.env.DIRECTORY_FILE ?? "/config/directory.json", "utf8"));
const COMPANIES = new Map(directory.companies.map((c) => [c.alias, c]));
const TENANTS = directory.tenants.map((t) => t.tenant_id);
const PEOPLE = directory.people.map((p) => {
  const company = COMPANIES.get(p.company);
  if (!company) throw new Error(`${p.username}: unknown company "${p.company}"`);
  return { email: `${p.username}@${company.domain}`, groups: [], assignments: [], ...p, companyRef: company };
});
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

// --- Mock company SSOs ---------------------------------------------------------
// One realm per company plays that company's own identity provider (Entra ID,
// Okta, ...). It holds the company's users and passwords; "platform" never does.

async function configureCompanySso(company) {
  const realm = company.sso.realm;
  await ensureRealm(realm, { displayName: company.sso.displayName, loginWithEmailAllowed: true, registrationAllowed: false });

  const client = await ensureClient(realm, {
    clientId: "platform-keycloak-broker",
    name: "Platform authorization server (Keycloak broker)",
    protocol: "openid-connect",
    publicClient: false,
    clientAuthenticatorType: "client-secret",
    secret: required("SSO_BROKER_SECRET"),
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: [`${PUBLIC_URL}/realms/platform/broker/${company.alias}/endpoint`],
    webOrigins: [],
    attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": `${PUBLIC_URL}/*` },
  });

  // Corporate IdPs put group membership into the id_token; do the same.
  const mappers = await get(`/${realm}/clients/${client.id}/protocol-mappers/models`);
  if (!mappers.find((m) => m.name === "groups")) {
    await api("POST", `/${realm}/clients/${client.id}/protocol-mappers/models`, {
      name: "groups", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper",
      config: { "claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "true", "userinfo.token.claim": "true" },
    });
  }

  const ids = {};
  for (const person of PEOPLE.filter((p) => p.company === company.alias)) {
    const user = await ensureUser(realm, {
      username: person.username, email: person.email, firstName: person.firstName, lastName: person.lastName,
      password: person.password ?? DEMO_PASSWORD,
    });
    for (const g of person.groups) {
      const group = await ensureGroup(realm, g);
      await api("PUT", `/${realm}/users/${user.id}/groups/${group.id}`);
    }
    ids[person.username] = user.id;
  }
  return ids;
}

// --- platform: the Platform authorization server -----------------------------------

async function configurePlatform() {
  await ensureRealm("platform", {
    displayName: "CoreCenas",
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
    // Which company the person belongs to: decides the home tenant of customer users.
    // (A plain attribute: Keycloak's organization mapper only emits its claim when
    // the client asks for the "organization" scope, which MCP clients don't.)
    {
      name: "company", protocolMapper: "oidc-usermodel-attribute-mapper",
      config: { "user.attribute": "company", "claim.name": "company", "jsonType.label": "String", "access.token.claim": "true", "id.token.claim": "false", "introspection.token.claim": "true" },
    },
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

  // Identity-first login: the user types an email, the Organization step
  // matches its domain and sends them to that company's SSO. So no default
  // provider on the redirector (earlier versions sent everyone to one IdP).
  const executions = await get("/platform/authentication/flows/browser/executions");
  const redirector = executions.find((e) => e.providerId === "identity-provider-redirector");
  if (redirector?.authenticationConfig) {
    await api("DELETE", `/platform/authentication/config/${redirector.authenticationConfig}`, undefined, { allow: [404] });
  }

  // Per company: a brokered identity provider, an Organization that owns the
  // email domain, and the people, pre-linked to their SSO identity so the
  // assignment store can be keyed on the platform subject from day one.
  const subjects = {};
  for (const company of COMPANIES.values()) {
    const ssoIds = await configureCompanySso(company);
    await ensureCompanyIdp(company);
    const org = await ensureOrganization(company);

    for (const person of PEOPLE.filter((p) => p.company === company.alias)) {
      const user = await ensureUser("platform", {
        username: person.username, email: person.email, firstName: person.firstName, lastName: person.lastName,
        attributes: { principal_type: [company.principal_type], company: [company.alias] },
      });
      const links = await get(`/platform/users/${user.id}/federated-identity`);
      if (!links.find((l) => l.identityProvider === company.alias)) {
        await api("POST", `/platform/users/${user.id}/federated-identity/${company.alias}`, {
          identityProvider: company.alias, userId: ssoIds[person.username], userName: person.username,
        });
      }
      await api("POST", `/platform/organizations/${org.id}/members`, user.id, { allow: [409] });
      subjects[person.username] = user.id;
    }
  }

  await configureRegistrationPolicies();
  return subjects;
}

async function ensureCompanyIdp(company) {
  const realm = company.sso.realm;
  const path = `/platform/identity-provider/instances/${company.alias}`;
  const { status, data: existing } = await api("GET", path, undefined, { allow: [404] });
  const idp = {
    alias: company.alias, displayName: company.sso.displayName.replace(/ \(mock\)$/, ""), providerId: "oidc", enabled: true,
    trustEmail: true, storeToken: false, firstBrokerLoginFlowAlias: "first broker login",
    config: {
      clientId: "platform-keycloak-broker", clientSecret: required("SSO_BROKER_SECRET"), clientAuthMethod: "client_secret_post",
      authorizationUrl: `${PUBLIC_URL}/realms/${realm}/protocol/openid-connect/auth`,
      tokenUrl: `${KC}/realms/${realm}/protocol/openid-connect/token`,
      jwksUrl: `${KC}/realms/${realm}/protocol/openid-connect/certs`,
      userInfoUrl: `${KC}/realms/${realm}/protocol/openid-connect/userinfo`,
      issuer: `${PUBLIC_URL}/realms/${realm}`,
      useJwksUrl: "true", validateSignature: "true", pkceEnabled: "true", pkceMethod: "S256",
      defaultScope: "openid email profile", syncMode: "FORCE", loginHint: "true",
    },
  };
  if (status === 404) await api("POST", "/platform/identity-provider/instances", idp);
  // Merge, so the Organization link (organizationId, kc.org.*) survives re-runs.
  else await api("PUT", path, { ...existing, ...idp, config: { ...existing.config, ...idp.config } });

  // Anyone who signs in through this SSO gets the company's principal type and alias.
  const mappers = await get(`${path}/mappers`);
  for (const [attribute, value] of [["principal_type", company.principal_type], ["company", company.alias]]) {
    const mapper = {
      name: attribute, identityProviderAlias: company.alias, identityProviderMapper: "hardcoded-attribute-idp-mapper",
      config: { syncMode: "FORCE", attribute, "attribute.value": value },
    };
    const current = mappers.find((m) => m.name === attribute);
    if (!current) await api("POST", `${path}/mappers`, mapper);
    else await api("PUT", `${path}/mappers/${current.id}`, { ...current, ...mapper });
  }
}

async function ensureOrganization(company) {
  const find = async () => (await get(`/platform/organizations?search=${encodeURIComponent(company.name)}&exact=true`)).find((o) => o.alias === company.alias);
  let org = await find();
  const rep = { name: company.name, alias: company.alias, enabled: true, domains: [{ name: company.domain, verified: true }] };
  if (!org) {
    await api("POST", "/platform/organizations", rep);
    org = await find();
  } else {
    await api("PUT", `/platform/organizations/${org.id}`, { ...org, ...rep });
  }
  const linked = await get(`/platform/organizations/${org.id}/identity-providers`);
  if (!linked.find((i) => i.alias === company.alias)) {
    await api("POST", `/platform/organizations/${org.id}/identity-providers`, company.alias);
  }
  // Route users whose email matches the company's domain straight to its SSO.
  const path = `/platform/identity-provider/instances/${company.alias}`;
  const idp = await get(path);
  await api("PUT", path, {
    ...idp,
    config: { ...idp.config, "kc.org.domain": company.domain, "kc.org.broker.redirect.mode.email-matches": "true" },
  });
  return org;
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
        `INSERT INTO tenants(tenant_id, name, zone, company) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name, zone = EXCLUDED.zone, company = EXCLUDED.company`,
        [t.tenant_id, t.name, t.zone, t.company ?? null],
      );
    }
    for (const s of PEOPLE) {
      const subject = subjects[s.username];
      await db.query(
        `INSERT INTO principals(subject, username, email, principal_type) VALUES ($1, $2, $3, $4)
         ON CONFLICT (subject) DO UPDATE SET username = EXCLUDED.username, email = EXCLUDED.email, principal_type = EXCLUDED.principal_type`,
        [subject, s.username, s.email, s.companyRef.principal_type],
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
const subjects = await configurePlatform();
await syncDirectory(subjects);
console.log(JSON.stringify({ ok: true, issuer: `${PUBLIC_URL}/realms/platform`, mcp: MCP_URL, subjects }));
