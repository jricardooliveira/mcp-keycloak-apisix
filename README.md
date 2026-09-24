# mcp-keycloak-apisix

A working, all-in-containers lab of an **OAuth-protected, multi-tenant MCP server**.

**CoreCenas** runs a contact-center platform. Its client companies, **MasIkea** and
**VodaFundas**, each have their own tenant on it. This lab gives the platform an MCP
server that Claude Desktop, Claude Code, claude.ai and ChatGPT can connect to. Before
using any tool you **sign in with your own company's SSO**; after that, every tool call
is checked against which tenants you're assigned to, with which role, and written to an
audit log.

Everything behind the MCP server (the platform's APIs, and each company's SSO) is
mocked, so the lab runs on a laptop with nothing but Docker.

- [Architecture](#architecture)
  - [What each piece does, and why it's there](#what-each-piece-does-and-why-its-there)
  - [Why these tools](#why-these-tools)
- [Set it up](#set-it-up)
- [Connect a client](#connect-a-client)
- [Things to try](#things-to-try)
- [Consoles and dashboards](#consoles-and-dashboards)
- [How to change things](#how-to-change-things)
- [How it works](#how-it-works)
- [FAQ (with example payloads)](#faq)
- [Troubleshooting](#troubleshooting)
- [Lab simplifications](#lab-simplifications)

---

## Architecture

```mermaid
flowchart LR
  C["AI client<br/>Claude / ChatGPT"] --> G["APISIX gateway<br/>:9080"]
  G --> M["MCP server<br/>zone eu1"]
  G --> K["Keycloak realm platform<br/>authorization server"]
  K --> E1["CoreCenas Entra ID<br/>(staff, mock)"]
  K --> E2["MasIkea Entra ID<br/>(mock)"]
  K --> E3["VodaFundas Okta<br/>(mock)"]
  M --> S[("Postgres<br/>assignments + audit")]
  M --> R[("Redis<br/>rate limits")]
  M -- "token exchange" --> K
  M -- "internal JWT<br/>one tenant, 5 min" --> B["mock portal-api<br/>+ mock rest-api"]
```

The AI client only ever talks to the gateway. The gateway fronts two things: the
Keycloak login pages and the MCP server. Everything else is on the internal Docker
network.

| Part | What it does | Where it lives |
| --- | --- | --- |
| **APISIX** | The only public entrance. Checks tokens early, rate-limits, strips smuggled identity headers | `apisix/apisix.yaml` (routes), `apisix/config.yaml` |
| **Keycloak realm `platform`** | CoreCenas' OAuth server: login, consent, tokens, self-registration of AI clients, token exchange | configured by `bootstrap/bootstrap.mjs` |
| **Keycloak realms `corecenas-entra`, `masikea-entra`, `vodafundas-okta`** | Mock SSOs: CoreCenas' own (for staff) and one per client company. They hold the users and passwords | `bootstrap/directory.json` |
| **MCP server** | The decision point: which person, which tool, which tenant, which role | `mcp-server/src/` (TypeScript) |
| **Postgres** | Tenants, assignments (who may work where), audit log. Also Keycloak's database | `db/init/01-schema.sql` |
| **Redis** | Rate-limit counters per person, tenant and risk tier | — |
| **Mock portal-api / rest-api** | Fake contact-center platform APIs. Accept only the one-tenant token the MCP server gets from Keycloak | `backend/server.mjs`, `openapi/` |
| **etcd** | Stores the gateway config so the APISIX dashboard can show it | loaded from `apisix/apisix.yaml` |

### What each piece does, and why it's there

Think of the platform as an office building where each client company (tenant) has its
own rooms. Each piece of the lab answers **exactly one question**, and none of them
trusts another to answer its question for it. That's the test for whether a piece
belongs: take it away, and something specific breaks or becomes unsafe.

| Piece | The one question it answers | In the building |
| --- | --- | --- |
| AI client | "What does the person want done?" | the visitor asking for something |
| APISIX gateway | "Is this request well-formed and not an attack?" | the front door with the security scanner |
| Keycloak (`platform` realm) | "Who is this person, and did they agree to let this AI act for them?" | reception, which checks ID and hands out visitor badges |
| Company SSOs (MasIkea, VodaFundas, CoreCenas) | "Is this really one of *our* people?" | each company's own badge office, which reception phones to confirm |
| MCP server | "May this person do this action, in this tenant, right now?" | the floor manager who checks the badge against the room list |
| Assignment store (Postgres) | "Which tenants may this person work in, with which role, until when?" | the room-access list |
| Token exchange + internal token | "Which one room is this key cut for?" | a key that opens one room for five minutes |
| Backend middleware | "Is this key genuine, and for which room?" | the lock on each room door |
| Mock portal-api / rest-api | "Do the actual work." | the room itself |
| Audit log | "Who did what, where, and when?" | the CCTV recording |

#### AI client (Claude Desktop, Claude Code, claude.ai, ChatGPT)

- **Job:** turns what you ask into tool calls, and handles login and token refresh for you.
- **Why it's there:** it's the product experience. People work in the AI tool they already use.
- **Not trusted.** It isn't ours, it can be tricked by prompt injection, and the safety hints
  it gets (read-only, destructive) are advisory. Every piece behind it assumes it could
  send anything.

#### APISIX gateway (`apisix/apisix.yaml`)

- **Job:** the single public entrance on port 9080. It routes login traffic to Keycloak
  and MCP traffic to the MCP server. Before a request goes further, it checks the token's
  signature, issuer and audience, rate-limits per IP, caps request sizes, strips identity
  headers a client might try to smuggle in (like `X-Tenant-ID`), and tags each request with
  an id.
- **Why it's there:** it stops junk and floods before they cost backend capacity, and it's
  one place to apply the same protections to every API. It also hides everything that
  shouldn't be public: the Keycloak admin console and master realm return 404 here.
- **Without it:** every service would need its own edge protection, and a scan or flood
  would hit the MCP server and Keycloak directly.
- **Doesn't:** decide what a person may do. It can't see the tool or tenant well enough to
  make that call, so it only filters. It never turns a token into trusted headers either;
  the services behind it check the token themselves.

#### Keycloak, realm `platform` (the authorization server)

- **Job:** CoreCenas' OAuth 2.1 server, the one the AI clients talk to. It lets AI apps
  register themselves (Dynamic Client Registration), asks for your email and sends you to
  your company's SSO, shows the consent screen, and issues a short-lived access token
  (10 min) that only works for this MCP server. It refreshes that token quietly. It also
  performs **token exchange**: it swaps a person's token for a 5-minute internal token
  pinned to one tenant.
- **Why it's there:** MCP clients only connect through the standard MCP OAuth flow
  (discovery, PKCE, audience-bound tokens). Something has to speak it, and it gives every
  company's users one issuer and one token format, whatever SSO is behind it.
- **Without it:** people would paste long-lived API keys into AI tools. Those keys would be
  unscoped, never expire, and couldn't be traced to a person.
- **Doesn't:** decide which tenants someone may touch. It knows *who* you are, not *where*
  you may go.

#### Company SSO realms (`corecenas-entra`, `masikea-entra`, `vodafundas-okta`)

- **Job:** each one simulates a company's own single sign-on. **MasIkea** signs in with its
  Microsoft Entra ID, **VodaFundas** with its Okta, and **CoreCenas** staff with CoreCenas'
  Entra ID. Each realm holds that company's users and passwords. Realm `platform` never
  does: it forwards the login to the right company ("brokering") and trusts the answer.
- **Why it's there:** every client company brings its own SSO, and its users should log in
  with the account they already have. When a company disables someone in its SSO, that
  person can't sign in to the platform any more. In a real setup, each identity provider in
  realm `platform` would point at the company's actual SSO. See [FAQ 4](#4-why-are-there-several-keycloak-realms-and-what-does-brokering-a-login-mean).
- **Doesn't:** talk to the AI clients. They only ever see realm `platform`, one issuer, no
  matter how many companies' SSOs sit behind it.

#### MCP server (`mcp-server/src/`)

- **Job:** the decision point. It checks the token again (it must be meant for this server),
  then, for every call: which tenant (from the explicit `tenant_id` argument), whether that
  tenant belongs to this server's zone, whether a client company's user is staying inside
  their own company's tenant, whether the person has an active assignment there, whether
  their role and scope are high enough, and whether they're under the rate limit. For risky
  tools it returns a plan and asks for confirmation first. Then it gets a one-tenant token
  and calls the backend. It writes an audit record for every call.
- **Why it's there:** it's the only place that knows the person, the tool and the tenant at
  the same time. It also turns many uneven backend routes into a small set of clear,
  task-level tools, each with a risk tier.
- **Without it:** the AI client would call the backends directly, where nothing checks
  tenant assignments or asks for confirmation.
- **Doesn't:** store business data or log people in. It's stateless: any number of copies can
  run side by side, since all state is in Postgres and Redis.

#### Assignment store (Postgres, `db/init/01-schema.sql`)

- **Job:** the explicit list of who may work in which tenant, with which role, until when,
  and why. It also holds the tenants (with their zone and owning company), the audit log,
  and the confirmation ids that have been used.
- **Why it's there:** "may this person work in tenant T?" must be a reviewable fact, not
  something implied by being logged in. Every change to it is logged too
  (`assignment_changes`).
- **Without it:** anyone with a login would effectively reach every tenant.
- **Doesn't:** check passwords or tokens. The same Postgres also holds Keycloak's own
  database, separately.

#### Redis

- **Job:** counts calls per (person, tenant, risk tier) per minute, plus a daily cap for the
  riskiest tools.
- **Why it's there:** it keeps the counts correct when several MCP server copies run at once.
  In-memory counters would each only see part of the traffic.

#### Token exchange and the internal token

- **Job:** before calling a backend, the MCP server asks Keycloak to swap the person's access
  token for an internal one. That token names exactly one tenant and role, says that the MCP
  server acted on the person's behalf (`act`), is meant only for the backends
  (`aud = platform-backend`), and expires in 5 minutes.
- **Why it's there:** the person's own token never goes further than the MCP server, and the
  backends never have to trust the MCP server's word about which tenant is meant. The
  tenant is inside a token Keycloak signed.

#### Backend middleware + mock portal-api / rest-api (`backend/server.mjs`)

- **Job:** the mocks stand in for the real platform APIs (campaigns, segments, customers,
  SMS, …) with fake data. What's *not* mock is their auth middleware. It accepts only the
  internal token, checks its signature, issuer, audience and `act` claim, and takes the
  tenant from the token, never from the URL or a header.
- **Why it's there:** defence in depth. Even if something upstream were wrong or bypassed, the
  backend still refuses any request without a valid key for that exact tenant.
- **Doesn't:** replace the backend's own permission checks. It adds a tenant lock in front of them.

#### Audit log (`audit_log` table + a JSON line per call on stdout)

- **Job:** one record per tool call, reads included. It records who (person and AI app),
  which tenant, which tool and risk tier, a hash of the arguments plus a redacted copy, the
  confirmation id, the outcome (allowed, planned, refused and why, error), which backend
  route was called, and how long it took.
- **Why it's there:** when CoreCenas staff can act across client tenants, this record is the
  evidence that access was legitimate, and the first place to look in an incident.
- **Doesn't:** store tokens, full personal data or prompt text.

#### Supporting pieces

| Piece | Role |
| --- | --- |
| **etcd** | Stores the gateway config so the APISIX dashboard can list and edit it |
| **gateway-seed** job (`apisix/seed/`) | Loads `apisix/apisix.yaml` into the gateway and removes anything not in the file, so the file stays the source of truth |
| **bootstrap** job (`bootstrap/`) | Configures all Keycloak realms (clients, scopes, token lifetimes, registration rules, one SSO + Organization per company) and syncs `directory.json` into the assignment store. Safe to re-run |
| **api-docs** (Swagger UI) | Read-only docs for the mock APIs on port 8082 |
| **cloudflared** | Only with `make tunnel`: gives the gateway a public HTTPS URL so cloud-hosted clients (claude.ai, ChatGPT) can reach it |

#### Why several pieces check the same token

The gateway, the MCP server and the backends all verify tokens, and none of it is
redundant. The gateway checks cheaply to reject junk early. The MCP server checks
because it makes the decision. The backends check because they hold the data. Each
check guards against a different failure.

### Why these tools

The section above explains what each *role* is for. This one explains why we picked
*these particular tools* to fill them, and which ones are only there so the lab runs on a
laptop.

**At a glance.** "Core" means the tool is part of the architecture and you'd run it in
production too. "Laptop only" means it's there to make the lab self-contained, and you'd
drop it or swap it for the real thing.

| Tool | What it is, in one line | Why we need it here | Core or laptop only? |
| --- | --- | --- | --- |
| **Keycloak** | Open-source identity server: logins, SSO, OAuth 2 / OpenID Connect tokens | The OAuth server MCP clients require, plus brokering to each company's SSO | Core |
| **Apache APISIX** | Open-source API gateway: a programmable reverse proxy with plugins | One hardened public entrance: token pre-check, rate limits, header stripping | Core |
| **PostgreSQL** | Open-source relational database | Assignments, audit log, single-use confirmations; also Keycloak's database | Core |
| **Redis** | In-memory key-value store, very fast counters with expiry | Rate limits shared by every MCP server copy and gateway node | Core |
| **Node.js + TypeScript + MCP SDK** | JavaScript runtime, typed JavaScript, and the official MCP library | The MCP server itself; also the mock backends and config scripts | Core (the MCP server) |
| **Docker + Compose** | Containers, and a tool to run many of them together from one file | Starts the whole stack with one command | Laptop only (production uses Kubernetes or VMs) |
| **etcd** | Distributed key-value store used by APISIX to hold its config | Only so the APISIX dashboard can browse and edit routes | Laptop only (optional) |
| **Mock company SSO realms** | Extra Keycloak realms pretending to be Entra ID / Okta | Stand-ins for each company's real SSO | Laptop only |
| **Mock portal-api / rest-api** | Tiny Node services with fake data | Stand-ins for the real platform APIs | Laptop only (the auth middleware is the real pattern) |
| **Swagger UI** | Web page that renders OpenAPI files as browsable API docs | Lets you see the mocked APIs | Laptop only (optional) |
| **cloudflared** | Cloudflare's tunnel client: gives a local port a public HTTPS URL | Lets claude.ai / ChatGPT, which live in the cloud, reach your laptop | Laptop only (optional) |
| **mcp-remote** | Small npm tool that bridges a local MCP client to a remote MCP server | Lets Claude Desktop use this server through `claude_desktop_config.json` | Client side, optional |

#### Keycloak

- **What it is:** an open-source (Apache-2.0) identity and access management server. It logs
  people in, federates with other identity providers, and issues OAuth 2 / OpenID Connect tokens.
- **Why we need an authorization server at all:** Claude and ChatGPT only connect to remote
  MCP servers through the standard MCP OAuth flow. That flow includes discovery,
  self-registration of clients (DCR), PKCE, consent, and tokens bound to one MCP server.
  Something has to speak it.
- **Why not connect Claude straight to Entra ID (or Okta):** those are the companies'
  SSOs, and they can't act as an MCP authorization server for us. They don't let arbitrary
  AI clients register themselves, and they can't issue tokens whose audience is our MCP
  server. Brokering through our own server also gives every company one issuer and one
  token format.
- **Why Keycloak:** it has everything this design leans on, in the free version:
  - **Standard token exchange,** for the one-tenant internal token.
  - **Claims shaped with mappers and scopes,** without writing code.
  - **Deep SSO brokering, plus Organizations,** to route each email domain to its company's
    SSO.
  - **RFC 9207 `iss`** in the login response.
  - **Mature Dynamic Client Registration policies.**
  - **Self-hosted, with no licence cost.**
- **Alternatives considered:**
  - **Zitadel** is very close. It has the cleanest built-in tenant model. But it's AGPL when
    self-hosted, and at the time of the design it lacked RFC 9207 and client metadata
    documents (CIMD).
  - **Auth0 / Okta Customer Identity** are paid SaaS.
  - **Entra ID** can't play this role (see above).
- **Laptop vs production:** here it runs in dev mode on one node. In production: 2+ nodes on
  a managed Postgres, realm config as code (like `bootstrap.mjs`), and events shipped to
  your log pipeline.

#### Apache APISIX

- **What it is:** an open-source (Apache-2.0) API gateway built on NGINX/OpenResty. You
  define routes, attach plugins (auth, rate limiting, rewriting, logging) and point them
  at upstream services.
- **Why we need a gateway:** one public entrance where junk is stopped cheaply before it
  reaches the MCP server or Keycloak. It checks token signature and audience, rate-limits,
  caps request sizes, strips identity headers clients try to smuggle in, and hides the
  admin console and master realm.
- **Why APISIX:** everything we use here is in the open-source edition:
  - **OpenID Connect / JWT validation** with rotating keys (JWKS) and audience checks.
  - **Rate limits backed by Redis,** correct across several gateway nodes.
  - **Response rewriting,** for the MCP login challenge.
  - **A built-in dashboard.**
  - **A plain-YAML standalone mode** for Git-managed config.
- **Alternatives considered:**
  - **Kong:** OIDC and advanced rate limiting are Enterprise (paid) features; the free JWT
    plugin can't follow rotating keys or check the audience.
  - **Traefik:** OIDC and MCP features are in paid Traefik Hub.
  - **Envoy:** powerful, but you assemble it from low-level filters.
  - **Plain NGINX:** no OIDC without NGINX Plus.
- **Laptop vs production:** in production you'd run 2+ identical nodes in **standalone YAML
  mode** (config file from Git, no etcd), with TLS, logs shipped out and a WAF (for example
  Coraza with the OWASP rules). The lab uses etcd only for the dashboard (see etcd below).

#### PostgreSQL

- **What it is:** an open-source relational database: tables, SQL, transactions, constraints.
- **Why we need it:** three things must be correct and durable:
  - **Who may work in which tenant** (assignments). Foreign keys, expiry dates and a trigger
    log every change.
  - **The audit log.** Queryable per tenant or person.
  - **Which confirmation ids were already used.** One atomic insert makes them single-use
    across all MCP server copies.
- **Why PostgreSQL:** transactions and constraints fit this data. Keycloak needs a database
  anyway and supports Postgres officially, so one engine serves both (in separate databases).
- **Alternatives:** MySQL/MariaDB would also work. A document store or a key-value store would
  make the constraints and audit queries harder.
- **Laptop vs production:** a managed Postgres with backups, and probably separate
  instances for Keycloak and the platform data.

#### Redis

- **What it is:** an in-memory key-value store. It's very fast, and keys can expire on their own.
- **Why we need it:** rate limits per (person, tenant, risk tier) must count calls across
  **all** MCP server copies, and the gateway's per-IP limits across all gateway nodes.
  Counters kept in each process's memory would each see only part of the traffic.
- **Why Redis:** atomic `INCR` plus expiry is exactly a rate-limit window, and APISIX supports
  it natively (`policy: redis`).
- **Alternatives:** counting in Postgres (slower, more load on the database), or
  Memcached (no atomic counters with the same guarantees). Valkey, an open-source Redis
  fork, is a drop-in replacement.
- **Laptop vs production:** a managed Redis/Valkey. If it's down, the lab refuses calls rather
  than letting them through unlimited.

#### Node.js, TypeScript and the official MCP SDK

- **What they are:** Node.js runs JavaScript on the server. TypeScript adds types to
  JavaScript. `@modelcontextprotocol/sdk` is the official MCP library from the protocol's
  maintainers.
- **Why we need them:** the MCP server is the one piece we write ourselves.
- **Why this stack:** the TypeScript SDK is the **reference implementation**, so it gets new
  spec features (auth, transports, protocol versions) first. It also covers what we need:
  stateless Streamable HTTP, JSON Schema tool inputs, and tool annotations. The same runtime
  also runs the mock backends, the config scripts and the tests.
- **Alternatives:** the Python SDK / FastMCP, Java (Spring AI), or Go. All are viable. Pick what
  your team maintains best.
- **Laptop vs production:** the MCP server is core. You'd deploy several copies per zone
  behind the gateway. That's safe because it's stateless.

#### Docker and Docker Compose

- **What they are:** Docker runs each service in an isolated container. Compose starts many
  containers together from one file (`docker-compose.yml`), with a private network between them.
- **Why we need them:** twelve services on a laptop (two of them one-shot setup jobs, and the
  tunnel only on demand), started with one command, the same way on every machine.
- **Laptop vs production:** laptop only. In production the same container images would run on
  Kubernetes or VMs, with managed Postgres and Redis.

#### Optional and laptop-only pieces

You can remove or ignore these without changing how the architecture works.

| Piece | What it is | Why it's in the lab | Can I skip it? |
| --- | --- | --- | --- |
| **etcd** | Distributed key-value store; APISIX's config store in its "traditional" mode | APISIX's built-in dashboard only works when config lives in etcd. `apisix/apisix.yaml` stays the source of truth (the `gateway-seed` job pushes it) | Yes. Switch APISIX to standalone YAML mode and drop etcd, `gateway-seed` and the dashboard. That's what you'd do in production |
| **Mock company SSO realms** (`corecenas-entra`, `masikea-entra`, `vodafundas-okta`) | Extra Keycloak realms | Pretend to be each company's Entra ID / Okta, so the brokered login works offline | Not in the lab, but in production they're replaced by the companies' real SSOs |
| **Mock portal-api / rest-api** | Small Node services with fake data | Give the tools something to call | In production they're replaced by the real APIs, which only need the same token-checking middleware |
| **Swagger UI** (`api-docs`) | Renders OpenAPI files as a web page | Browse the mocked APIs on port 8082 | Yes. `docker compose stop api-docs` |
| **cloudflared** | Cloudflare quick-tunnel client | A public HTTPS URL, so claude.ai / ChatGPT can reach your laptop | Yes. Only started by `make tunnel`; Claude Desktop and Claude Code work without it. In production the gateway has a real domain and TLS certificate |
| **mcp-remote** | npm bridge from a local MCP client to a remote server | Lets Claude Desktop connect through its config file, with the OAuth login done on your machine | Yes, if you use a Claude Desktop custom connector (needs the tunnel) or Claude Code instead |
| **`bootstrap` and `gateway-seed` jobs** | One-shot containers that apply config | Configure Keycloak and APISIX from files in this repo | Keep the *idea* (configuration as code). In production they'd run in your CI/CD pipeline |

---

## Set it up

**You need:** Docker Desktop (or Docker Engine with Compose v2), and Node.js 20+ if you
want to run the tests or connect Claude Desktop.

```bash
git clone https://github.com/jricardooliveira/mcp-keycloak-apisix.git
cd mcp-keycloak-apisix
make up          # first start takes 1–2 minutes
make test        # optional: full login + tool calls in a script, for 4 users
```

When `make up` finishes it prints the URLs. Everything listens on `127.0.0.1` only.

| What | URL | Login |
| --- | --- | --- |
| **MCP server** (give this to your AI client) | `http://localhost:9080/mcp` | you sign in on first use |
| Keycloak admin console | http://localhost:8081 | `admin` / `admin` |
| APISIX dashboard | http://localhost:9180/ui | gear icon → admin key `local-apisix-admin-key` |
| Mock API docs (Swagger UI) | http://localhost:8082 | — |

**Demo users.** All passwords are `Passw0rd!`. Type the email on the first login page;
you're then sent to that company's SSO.

| Email | Company (SSO) | Can do |
| --- | --- | --- |
| `alice@corecenas.example` | CoreCenas staff (CoreCenas Entra ID) | Supervisor in **1001 MasIkea**, support operator in **1002 VodaFundas**. Also assigned to 2001 Initech Bank, but that tenant lives in another zone |
| `bob@corecenas.example` | CoreCenas staff | Viewer in 1001. His 1002 assignment has **expired** |
| `carol@corecenas.example` | CoreCenas staff | Can sign in, but has no tenants |
| `marta@masikea.example` | MasIkea (MasIkea Entra ID) | Supervisor in her own tenant, **1001 MasIkea**, and nowhere else |
| `vasco@vodafundas.example` | VodaFundas (VodaFundas Okta) | Support operator in **1002 VodaFundas**. He's *also* assigned to 1001 on purpose, to show that a client company's user is still refused outside their own tenant |

Other commands:

```bash
make down          # stop, keep data
make reset         # stop and delete all data (fresh start on next make up)
make logs          # follow the MCP server and gateway logs
make audit         # last 30 tool calls: who, tenant, tool, allowed/denied and why
make assignments   # who may work in which tenant
```

---

## Connect a client

The first time a client connects, it opens a browser. You type your email, Keycloak
sends you to your company's SSO, you sign in, approve the consent screen, and you're
connected. The client refreshes its token quietly after that.

```mermaid
sequenceDiagram
  participant U as You (marta@masikea.example)
  participant C as AI client
  participant G as APISIX + MCP server
  participant K as Keycloak (platform)
  participant E as MasIkea SSO
  C->>G: call /mcp without a token
  G-->>C: 401 + where to log in
  C->>K: register itself (DCR)
  C->>U: open browser
  U->>K: type your email
  K->>E: @masikea.example → MasIkea's SSO
  U->>E: password (and MFA)
  E-->>K: identity
  U->>K: approve consent
  K-->>C: access token (10 min) + refresh token
  C->>G: tool calls with the token
```

### Claude Desktop (local, recommended)

Claude Desktop runs a small bridge (`mcp-remote`) on your machine, so nothing needs
to be public.

1. **Quit Claude Desktop** (Cmd+Q). It rewrites its config file while running.
2. Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json`,
   keeping what's already there:

   ```bash
   f=~/Library/Application\ Support/Claude/claude_desktop_config.json
   cp "$f" "$f.bak"
   jq --arg npx "$(command -v npx)" '.mcpServers.corecenas = {
         "command": $npx,
         "args": ["-y", "mcp-remote", "http://localhost:9080/mcp", "--allow-http"]
       }' "$f.bak" > "$f"
   ```

   The full path to `npx` matters: Claude Desktop doesn't load your shell's `PATH`.
3. Open Claude Desktop. A browser tab opens: type `alice@corecenas.example`, sign in with
   `Passw0rd!`, click **Yes**.
4. In a new chat, check the tools menu for **corecenas**, and ask *"Which tenants can I work in?"*

### Claude Code

```bash
make claude        # = claude mcp add --transport http corecenas http://localhost:9080/mcp
```

Then in Claude Code run `/mcp`, pick **corecenas**, choose **Authenticate**.

### claude.ai, ChatGPT, or a Claude Desktop custom connector

These connect from the vendor's cloud, so they need a public HTTPS URL. The lab uses
a free Cloudflare quick tunnel (no account needed):

```bash
make tunnel        # prints https://<random>.trycloudflare.com/mcp
```

Add the printed URL as a custom connector (claude.ai / Claude Desktop: **Settings →
Connectors → Add custom connector**; ChatGPT: **Settings → Apps & Connectors →
Advanced → Developer mode → Create**). Leave client id and secret empty.

- The tunnel URL is **random and changes every time**. `make tunnel` re-points Keycloak,
  the gateway and the MCP server at it, which signs everyone out.
- **The login pages are public while the tunnel runs.** Change the demo passwords first
  (see [Change a password](#change-a-password-or-disable-a-user)).
- `make local` stops the tunnel and goes back to `http://localhost:9080`.

---

## Things to try

Signed in as **alice** (CoreCenas staff):

| Ask | What you'll see |
| --- | --- |
| *"Which tenants can I work in?"* | Your assignments, roles and zones |
| *"How are MasIkea's queues right now?"* | Live stats (mock) |
| *"Compare the conversion rates of MasIkea's campaigns."* | Campaign stats |
| *"Find customer Maria Santos in MasIkea."* | Personal data: Claude must give a reason, which is audited |
| *"Create a segment in MasIkea called High spenders with rule lifetime_value > 8000."* | A **plan** first; it only runs after you confirm |
| *"Pause the Loyalty NPS survey campaign at MasIkea."* | Plan, then an explicit yes |
| *"Send an SMS to +351910000002 from MasIkea saying the order shipped."* | Plan with a cost estimate |
| *"Start the 5G upgrade campaign at VodaFundas."* | **Refused**: support operator is below supervisor |
| *"List campaigns for Initech Bank."* | **Refused**: that tenant is served by zone eu2 |

Signed in as **marta** (MasIkea): *"Show MasIkea's campaigns"* works; *"Show VodaFundas'
campaigns"* is **refused**: that tenant belongs to another company.

Then run `make audit` to see every call, including the refused ones.

To switch users in Claude Desktop: quit it, run `rm -rf ~/.mcp-auth`, reopen, and sign
in with another email.

---

## Consoles and dashboards

### Keycloak admin console — http://localhost:8081

Sign in with `admin` / `admin`. Use **Manage realms** (top left) to switch realms.

| In realm `platform` | What you'll find |
| --- | --- |
| **Clients** | `platform-mcp-server` (does token exchange), `platform-backend` (audience for portal-api/rest-api), and one client per AI app that registered itself, e.g. *MCP CLI Proxy* = Claude Desktop |
| **Client scopes** | `platform:read`, `platform:write` (what you consent to), `tenant-<id>` and `role-<role>` (used to build the one-tenant token), `backend-audience` |
| **Users**, **Sessions** | all five people, linked to their company SSO; who is signed in, with which client |
| **Identity providers** | `corecenas`, `masikea`, `vodafundas`: the brokers to each company's SSO |
| **Organizations** | *CoreCenas*, *MasIkea*, *VodaFundas*, each with its email domain and linked identity provider (this is what routes the email-first login) |
| **Events** | logins, token exchanges, app registrations and failed registrations |
| **Clients → Client registration** | the rules for AI apps registering themselves |

The company realms (`corecenas-entra`, `masikea-entra`, `vodafundas-okta`) hold each
company's users and passwords, as their real SSOs would.

### APISIX dashboard — http://localhost:9180/ui

Click the gear icon, enter `local-apisix-admin-key`. **Routes** lists the 8 gateway
routes with a description each; **View** shows a route's plugins (token check, rate
limit, …). **Upstreams** shows the MCP server and Keycloak.

### Mock API docs — http://localhost:8082

Swagger UI for the mocked **rest-api** and **portal-api**: every route, which MCP tool
calls it, and what the internal token must contain. Read-only: the mocks are only
reachable from inside Docker, and only with the token the MCP server gets per call.

---

## How to change things

Most configuration is **code in this repo**, applied by a command. Some things can
also be changed in a console. Use this to decide where:

```mermaid
flowchart TD
  Q{"What do you want<br/>to change?"}
  Q -->|"client companies, tenants,<br/>people, assignments, client hosts"| D["edit bootstrap/directory.json<br/>then: make bootstrap"]
  Q -->|"token lifetimes, scopes,<br/>consent texts"| B["edit bootstrap/bootstrap.mjs<br/>then: make bootstrap"]
  Q -->|"gateway routes,<br/>rate limits"| A["edit apisix/apisix.yaml<br/>then: make gateway-sync"]
  Q -->|"MCP tools,<br/>mock data"| T["edit mcp-server/src/tools.ts<br/>or backend/server.mjs, rebuild"]
  Q -->|"sessions, consents,<br/>passwords, disabling users"| UI["Keycloak admin console<br/>(kept across restarts)"]
```

**Why this matters:** `make bootstrap` also runs on every `make up` and `make tunnel`.
It resets whatever it manages to what the files say. The table shows what it
overwrites; everything else you change in the Keycloak console is kept.

| `make bootstrap` resets | Kept (safe to change in the console) |
| --- | --- |
| realm `platform` token and session lifetimes, event settings | sessions, consents, events already recorded |
| client scopes `platform:read`, `platform:write`, `tenant-*`, `role-*`, `backend-audience` (incl. their mappers) | any other client scope you create |
| clients `platform-mcp-server`, `platform-backend`, and each company realm's `platform-keycloak-broker` | clients that AI apps registered, clients you create |
| the identity provider, Organization and SSO realm of every company in `directory.json` | identity providers and organizations you add by hand |
| the anonymous client-registration policies | other client policies |
| name, email and company of people in `directory.json`; their assignments | passwords and enabled/disabled (set only when a person is first created), people not in the file |

### Add a client company

Say a new client, **PinguDoce**, signs up and signs in with Google Workspace.

1. In `bootstrap/directory.json`, add the company, its tenant, and at least one person:

   ```json
   "companies": [
     ...,
     { "alias": "pingudoce", "name": "PinguDoce", "domain": "pingudoce.example", "principal_type": "customer_user",
       "sso": { "realm": "pingudoce-google", "displayName": "PinguDoce Google Workspace (mock)" } }
   ],
   "tenants": [
     ...,
     { "tenant_id": 1003, "name": "PinguDoce", "zone": "eu1", "company": "pingudoce" }
   ],
   "people": [
     ...,
     { "username": "paula", "company": "pingudoce", "firstName": "Paula", "lastName": "Pinto",
       "assignments": [ { "tenant_id": 1003, "role": "supervisor", "expires_at": null, "reason": "PinguDoce admin" } ] }
   ]
   ```

2. Run `make bootstrap`. This creates:
   - the mock SSO realm `pingudoce-google`, with paula and her password
   - identity provider `pingudoce` and Organization *PinguDoce* (domain `pingudoce.example`)
     in realm `platform`, so `@pingudoce.example` emails go to PinguDoce's SSO
   - tenant 1003 in the store, with the `tenant-1003` scope the one-tenant token needs
   - paula's account, linked to her SSO identity, with her assignment
3. paula can sign in as `paula@pingudoce.example`.

The gateway needs no change: it allows every realm except `master`. The mock backends
start a new tenant with empty data. To give it campaigns or customers, add an entry to
the `data` object in `backend/server.mjs`, then run `docker compose up -d --build rest-api portal-api`.

**Connecting a company's real SSO** instead of a mock realm: the identity provider's
settings are built in `ensureCompanyIdp()` in `bootstrap/bootstrap.mjs` from the mock
realm's URLs. For a real SSO you'd give the company its own issuer, client id and secret
there (for example from extra fields under `sso` in `directory.json`), and register the
redirect URI `http://…/realms/platform/broker/<alias>/endpoint` with the company's SSO.

### Add a tenant

Add it to `tenants` in `bootstrap/directory.json`, with the owning company (or `null`
for a tenant only staff work in), then `make bootstrap`:

```json
{ "tenant_id": 1004, "name": "Umbrella Health", "zone": "eu1", "company": null }
```

The zone must be `eu1` for this MCP server to serve it. Any other zone gets the "served
by zone …" refusal. Tenants are never deleted by the sync, because the audit log refers to them.

### Grant, change or revoke an assignment

Edit the person's `assignments` in `bootstrap/directory.json`, then `make bootstrap`.

```json
{
  "username": "bob", "company": "corecenas", "firstName": "Bob", "lastName": "Barros",
  "assignments": [
    { "tenant_id": 1001, "role": "supervisor", "expires_at": "2026-12-31", "reason": "Covering for alice" }
  ]
}
```

- **Roles**, lowest to highest: `viewer`, `support_operator`, `supervisor`, `admin`.
  Reads need viewer, personal data and simple writes need support_operator, and
  destructive or costly actions need supervisor.
- **`expires_at`**: a date, or `null` for no expiry. After it passes, calls are refused.
- **Client company users** can only ever work in their own company's tenant. An assignment
  to another company's tenant is refused anyway (vasco shows this).
- For a listed person, the file is complete: an assignment you remove from the file
  is removed from the store. `"assignments": []` revokes everything.
- Changes reach the MCP server **within 60 seconds** (its decision cache). No new login needed.
- Every change is logged in the `assignment_changes` table.

For a quick one-off test you can also use SQL. The next `make bootstrap` puts the
file's version back:

```bash
docker compose exec postgres psql -U platform -d platform -c \
  "UPDATE assignments SET role='supervisor' WHERE tenant_id=1001
   AND subject=(SELECT subject FROM principals WHERE username='bob');"
```

### Add a person

Add them to `people` in `bootstrap/directory.json`, with their `company`:

```json
{
  "username": "dave", "company": "corecenas", "firstName": "Dave", "lastName": "Duarte",
  "assignments": [ { "tenant_id": 1001, "role": "viewer", "expires_at": null, "reason": "New in customer success" } ]
}
```

Their email becomes `<username>@<company domain>` (here `dave@corecenas.example`). Optional
fields: `"email"`, `"password"` (default `DEMO_PASSWORD`, i.e. `Passw0rd!`) and `"groups"`.
Run `make bootstrap`; they can sign in right away.

Removing someone from the file does **not** delete them or their assignments (the
sync only manages people it lists). To cut access, set `"assignments": []` first and
run `make bootstrap`, or disable them as described next.

### Change a password or disable a user

**Password:** Keycloak admin console → the person's **company realm** (for example
`masikea-entra`) → **Users** → the user → **Credentials** → **Reset password** (turn
*Temporary* off). This is kept across restarts. To change the default for new users, set
`DEMO_PASSWORD=...` in `.env` before they're first created, or run `make reset` to
recreate everyone.

**Disable someone** (offboarding): turn **Enabled** off for the user in **both** places.

- Their **company realm** (like their company disabling them in its SSO): stops new logins.
- Realm **platform**: stops their existing connection too. Their AI client's next token
  refresh fails with *User disabled*, so access ends within 10 minutes (the access
  token lifetime).

Disabling in the company realm alone doesn't end a session that already exists: Keycloak
doesn't recheck the upstream login when a client refreshes its token. Both settings
survive `make bootstrap`.

### See who is connected, sign someone out, or revoke an app

- **Who is connected:** realm `platform` → **Sessions**, or **Users** → user → **Sessions**.
- **Cut one app's access for one person:** **Users** → user → **Consents** → **Revoke** on
  the app. This is the reliable way: AI clients ask for `offline_access`, so their
  refresh tokens are *offline* tokens, which signing out a normal session doesn't end.
  Revoking the consent does. The app will ask the person to sign in again.
- **Cut everything for one person:** disable them in realm `platform`
  ([above](#change-a-password-or-disable-a-user)).
- **Remove a registered app completely:** **Clients** → the app (e.g. *MCP CLI Proxy*) →
  **Action → Delete**. The app will register itself again on its next connection.
  For Claude Desktop, also delete `~/.mcp-auth` so the bridge doesn't reuse the old
  registration.

### Allow a new AI client to register

AI apps register themselves (Dynamic Client Registration). Keycloak only accepts a
registration when every URL in it (the login callback and the app's own homepage)
is on a host in `dcrTrustedHosts`:

```json
"dcrTrustedHosts": ["localhost", "127.0.0.1", "claude.ai", "claude.com", "anthropic.com",
                    "chatgpt.com", "openai.com", "platform.openai.com", "github.com"]
```

If a client fails with *"Policy 'Trusted Hosts' rejected request"*, find the host in
its error (or in realm `platform` → **Events**), add it here, and run `make bootstrap`. You
can look at the policy under realm `platform` → **Clients** → **Client registration**;
edit it in the file, not there.

### Change token lifetimes or consent texts

These are in `bootstrap/bootstrap.mjs`, function `configurePlatform`:

| Setting | Where | Default |
| --- | --- | --- |
| Access token lifetime | `accessTokenLifespan` | 600 s |
| Idle time before the login expires | `ssoSessionIdleTimeout` | 48 h |
| Refresh token rotation | `revokeRefreshToken` | on (each refresh token works once) |
| Internal (one-tenant) token lifetime | `"access.token.lifespan"` on `platform-mcp-server` | 300 s |
| Consent screen text | `consent("…")` on `platform:read` / `platform:write` | — |

Run `make bootstrap` after editing.

### Look at events

Realm `platform` → **Events** → **User events** (`LOGIN`, `CODE_TO_TOKEN`, `TOKEN_EXCHANGE`,
`CLIENT_REGISTER`, `CLIENT_REGISTER_ERROR`, …) and **Admin events** (configuration changes).
Events are kept 90 days. To record more event types: **Realm settings → Events → User
events settings**.

### Change a gateway route or rate limit

Edit `apisix/apisix.yaml`, then:

```bash
make gateway-sync
```

For example, to allow 30 client registrations per minute instead of 10, change
`count: 10` under the `as-registration` route. You can also edit in the APISIX
dashboard. That takes effect immediately, but the next `make gateway-sync` or
`make up` puts the file's version back.

### Add or change an MCP tool

Tools are declared in `mcp-server/src/tools.ts`. Each entry has a name, description,
**risk tier** (`T0` read, `T1` personal data, `T2` reversible write, `T3`
destructive/costly), required scope, minimum role, input schema and a `run`
function. T2/T3 tools also have a `plan` function that describes what would happen.
The MCP server adds `tenant_id`, `purpose` (T1) and `confirmation_id` (T2/T3) to the
input for you.

1. Add the tool in `tools.ts` (copy a similar one).
2. If it needs a new backend route, add it to `backend/server.mjs` and document it
   in `openapi/rest-api.yaml` or `openapi/portal-api.yaml`.
3. Rebuild: `docker compose up -d --build mcp-server rest-api portal-api`.
4. Reconnect the client so it fetches the new tool list.

---

## How it works

### What happens on every tool call

```mermaid
flowchart TD
  A["tool call + token"] --> G{"APISIX:<br/>token valid for this server?"}
  G -- no --> X1["401: log in again"]
  G -- yes --> Z{"tenant in this zone?"}
  Z -- no --> X2["refused + audited"]
  Z -- yes --> H{"client company user:<br/>own company's tenant?"}
  H -- no --> X2
  H -- yes --> T{"active assignment,<br/>role and scope high enough?"}
  T -- no --> X2
  T -- yes --> L{"under the<br/>rate limit?"}
  L -- no --> X2
  L -- yes --> P{"write tool<br/>(T2 / T3)?"}
  P -- "yes, no confirmation" --> PL["return a plan<br/>+ confirmation id"]
  P -- "no, or valid confirmation" --> EX["get a 5-min token<br/>for this one tenant"]
  EX --> BE["call portal-api / rest-api"] --> OK["result + audited"]
```

1. **APISIX** checks the token's signature, issuer and audience (it must be meant for
   this MCP server) before the request goes any further.
2. **The MCP server** checks the token again, then, for this exact call: the tenant from
   the `tenant_id` argument; that the tenant belongs to zone `eu1`; for a client company's
   user, that the tenant is their own company's (from the token's `company` claim); an
   active assignment; the role; the scope; and the rate limit per (person, tenant, tier).
3. **Write tools** return a plan first. The plan comes with a confirmation id that is
   signed, single-use, valid for 5 minutes, and tied to the same person, tenant, tool and
   arguments. The action only runs when the tool is called again with that id.
4. **The MCP server swaps your token** at Keycloak for a 5-minute token that only works for
   this one tenant and role. Your own token never goes further than the MCP server.
5. **portal-api / rest-api** accept only that internal token, and take the tenant from it,
   never from the URL or a header.
6. **Every call** is written to the audit log: allowed, planned, refused (with the
   reason) or failed, reads included.

### The two tokens

| | Your access token | Internal token |
| --- | --- | --- |
| Issued to | the AI client, after you sign in | the MCP server, by token exchange |
| Audience | `http://localhost:9080/mcp` | `platform-backend` |
| Lifetime | 10 min (refreshed quietly) | 5 min |
| Carries | who you are, `principal_type`, `company`, `platform:read` / `platform:write` | who you are, `tenant_id`, `role`, `act: platform-mcp-server` |
| Used by | APISIX and the MCP server | portal-api and rest-api |

### Tools and risk tiers

| Tier | Tools | Minimum role | Confirmation |
| --- | --- | --- | --- |
| T0 read | `get_my_context`, `list_skills`, `get_skill_schedule`, `get_realtime_stats`, `list_campaigns`, `get_campaign_stats`, `list_segments` | viewer | none |
| T1 personal data | `search_customers`, `get_customer_profile`, `get_lead` (need a `purpose`) | support_operator | none |
| T2 reversible write | `create_lead`, `upsert_segment` (support_operator), `update_tenant_setting` (supervisor) | see left | plan → execute |
| T3 destructive / costly | `start_campaign`, `pause_campaign`, `add_to_blacklist`, `send_sms` | supervisor | plan → execute, with explicit restatement |

A token with only `platform:read` doesn't see the write tools at all. Calling one anyway
returns `403 insufficient_scope` (`make test-readonly` shows this).

### Project layout

```
docker-compose.yml     all services
Makefile               the commands in this README
bootstrap/
  directory.json       companies + SSOs, tenants, people, assignments, client hosts  ← edit this
  bootstrap.mjs        Keycloak config as code + sync of directory.json
apisix/
  apisix.yaml          gateway routes and plugins                                     ← and this
  config.yaml          gateway process settings (etcd, admin key)
  seed/                loads apisix.yaml into the gateway (make gateway-sync)
mcp-server/src/
  tools.ts             tool catalogue                                                 ← and this
  server.ts            HTTP, 401 challenge, per-call authorization
  auth.ts store.ts guards.ts backend.ts config.ts
backend/server.mjs     mock portal-api + rest-api, incl. their data
openapi/               API docs for the mocks
db/init/               database schema
scripts/               tunnel + public URL switching
tests/e2e.mjs          scripted client: register, log in, call tools
```

---

## FAQ

Questions a developer new to this stack usually asks, with the answers, where to look in
the code, and **real payloads** captured from this lab (open the *Example* blocks). In
the examples, tokens are shortened to `eyJ…` and ids are from one run; yours will differ.

### 1. When Claude first connects to `/mcp`, how does it find out where to log in?

It follows a chain of standard discovery documents. Nothing is configured in the client
except the MCP URL.

1. Claude calls `POST /mcp` without a token. The MCP server answers **401** with a header
   that says where to look next.
2. Claude fetches that **Protected Resource Metadata** (RFC 9728). It names this server
   and its authorization server.
3. Claude fetches the **authorization server metadata** (RFC 8414) from Keycloak. It learns the
   login, token and registration endpoints, and that PKCE S256 is supported. APISIX maps the
   RFC 8414 URL shape onto Keycloak's layout (routes `as-metadata-*`).
4. Claude **registers itself** at the registration endpoint (question 3), then opens the
   browser for the login with PKCE.

The 401 is what starts the whole flow; without it the client has no way to discover the
login. Code: `authenticate()` and the `prm` object in `mcp-server/src/server.ts`.

<details>
<summary><b>Example:</b> the 401, the resource metadata, the authorization server metadata</summary>

```http
POST /mcp HTTP/1.1
Host: localhost:9080
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="http://localhost:9080/.well-known/oauth-protected-resource/mcp", scope="platform:read platform:write offline_access"

{"error":"unauthorized","error_description":"Bearer token required"}
```

`GET /.well-known/oauth-protected-resource/mcp`:

```json
{
  "resource": "http://localhost:9080/mcp",
  "authorization_servers": ["http://localhost:9080/realms/platform"],
  "scopes_supported": ["platform:read", "platform:write", "offline_access"],
  "bearer_methods_supported": ["header"],
  "resource_name": "CoreCenas Contact Center (eu1)"
}
```

`GET /.well-known/oauth-authorization-server/realms/platform` (excerpt):

```json
{
  "issuer": "http://localhost:9080/realms/platform",
  "authorization_endpoint": "http://localhost:9080/realms/platform/protocol/openid-connect/auth",
  "token_endpoint": "http://localhost:9080/realms/platform/protocol/openid-connect/token",
  "registration_endpoint": "http://localhost:9080/realms/platform/clients-registrations/openid-connect",
  "code_challenge_methods_supported": ["plain", "S256"],
  "authorization_response_iss_parameter_supported": true
}
```

</details>

### 2. Why does the MCP server reject a valid Keycloak token that was issued for another app?

Because a token is only valid for the resource it was issued for: its **audience** (`aud`)
must contain `http://localhost:9080/mcp`. Both APISIX (`claim_schema` on route
`mcp-authenticated`) and the MCP server (`jwtVerify(..., { audience: config.resource })` in
`mcp-server/src/auth.ts`) check it.

This prevents **token replay across services**. Without the check, a token someone got for
a harmless app (or a token leaked by any other service using the same Keycloak) could be
replayed against the MCP server. The MCP spec requires this check, and forbids the reverse
too: the MCP server must never forward a token it received to another service (see question 5).

Keycloak puts the audience in through mappers on the `platform:read` / `platform:write` scopes
(its workaround for RFC 8707 Resource Indicators).

<details>
<summary><b>Example:</b> the token request, the token, and a rejected token</summary>

Token request, after the login redirected back with a code:

```http
POST /realms/platform/protocol/openid-connect/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=6af13ccc-de47-c1b7-7963-d82a843097f8.ufwlQ3Jk…
&redirect_uri=http://localhost:33418/callback
&client_id=216a574b-edd5-4579-a33d-7a343329b994
&code_verifier=XC5T0UXNmHiOqBt5BDq5sG37tplGgPHVEIG0WP5T9h8
&resource=http://localhost:9080/mcp
```

```json
{
  "access_token": "eyJ…",
  "expires_in": 600,
  "refresh_token": "eyJ…",
  "token_type": "Bearer",
  "scope": "platform:read offline_access platform:write"
}
```

The access token, decoded. Note the two audiences: this MCP server, and the MCP server's
own Keycloak client (needed for token exchange, question 5):

```json
{
  "iss": "http://localhost:9080/realms/platform",
  "aud": ["platform-mcp-server", "http://localhost:9080/mcp"],
  "sub": "de4a1552-3ccc-4765-be99-e8ce1667e86f",
  "azp": "216a574b-edd5-4579-a33d-7a343329b994",
  "scope": "platform:read offline_access platform:write",
  "name": "Alice Almeida",
  "email": "alice@corecenas.example",
  "principal_type": "staff",
  "company": "corecenas",
  "iat": 1790277724,
  "exp": 1790278324
}
```

A token that isn't valid for this server is stopped at the gateway, with a challenge
that tells the client to log in again:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", resource_metadata="http://localhost:9080/.well-known/oauth-protected-resource/mcp", scope="platform:read platform:write offline_access"
```

</details>

### 3. What is Dynamic Client Registration, and what stops anyone from registering a malicious client?

**Dynamic Client Registration (DCR)** lets an app register itself as an OAuth client with
one HTTP call, instead of an admin creating it by hand. Claude and ChatGPT need it because
every user connects their own client instance to arbitrary MCP servers; nobody could
pre-create all of those in Keycloak.

Anyone can call the registration endpoint, so it's restricted by several layers:

- **Trusted hosts:** every URL in the registration (the login callback and the app's
  homepage) must be on a host in `dcrTrustedHosts` (`bootstrap/directory.json`). A client
  can't register a callback on `evil.example`, so it can't receive login codes there.
- **Consent screen:** a newly registered client can't get a token silently. The person sees
  the app's name and the permissions it asks for, and must approve.
- **PKCE:** the login code is useless without the secret the client generated at the start,
  so an intercepted code can't be redeemed.
- **Limits:** only the `platform:*` and `offline_access` scopes may be requested, at most 200
  registered clients, and APISIX allows 10 registrations per minute per IP (route
  `as-registration`).
- **Audience-bound tokens:** even a registered client only gets tokens for this MCP server.

What it doesn't stop: an app on an allowed host (such as `localhost`) registering under a
misleading name. The consent screen and the audit log are the controls there.

<details>
<summary><b>Example:</b> an accepted and a rejected registration</summary>

```http
POST /realms/platform/clients-registrations/openid-connect HTTP/1.1
Content-Type: application/json

{
  "client_name": "Claude",
  "redirect_uris": ["http://localhost:33418/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": "platform:read platform:write offline_access"
}
```

```http
HTTP/1.1 201 Created

{
  "client_id": "216a574b-edd5-4579-a33d-7a343329b994",
  "client_name": "Claude",
  "redirect_uris": ["http://localhost:33418/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "scope": "offline_access platform:read platform:write",
  "registration_client_uri": "http://localhost:9080/realms/platform/clients-registrations/openid-connect/216a574b-…",
  "registration_access_token": "eyJ…"
}
```

The same request with `"redirect_uris": ["https://evil.example/callback"]`:

```http
HTTP/1.1 403 Forbidden

{
  "error": "insufficient_scope",
  "error_description": "Policy 'Trusted Hosts' rejected request to client-registration service. Details: URI doesn't match any trusted host or trusted domain"
}
```

</details>

### 4. Why are there several Keycloak realms, and what does "brokering" a login mean?

**Each company SSO realm simulates the single sign-on of one company.** CoreCenas' client
companies bring their own: **MasIkea** signs in with its Microsoft Entra ID (realm
`masikea-entra`), **VodaFundas** with its Okta (realm `vodafundas-okta`), and CoreCenas' own
staff use CoreCenas' Entra ID (realm `corecenas-entra`). Their users log in with their own
company account, and CoreCenas never stores their passwords. In the lab, each of those realms
plays that company's SSO: it holds the company's users and passwords, exactly as the real
one would.

**Realm `platform`** is CoreCenas' authorization server. It's the only one the AI clients ever
talk to, whatever company the user belongs to. When it needs to log someone in, it asks for
their email, picks the company from the email's domain, and **brokers** the login to that
company's SSO:

```mermaid
sequenceDiagram
  participant U as marta@masikea.example
  participant P as Keycloak "platform"
  participant A as MasIkea SSO (masikea-entra)
  U->>P: log in (started by the AI client)
  P->>U: "what's your email?"
  U->>P: marta@masikea.example
  P->>U: domain masikea.example → redirect to MasIkea's SSO
  U->>A: password (and MFA)
  A->>P: authorization code
  P->>A: exchange code for an id_token (server to server)
  P->>P: verify signature, find marta's linked account, add claims
  P-->>U: platform's own tokens for the AI client
```

What routes the email is a **Keycloak Organization** per company: it owns the company's
email domain and is linked to the company's identity provider in realm `platform`.

Why broker instead of letting the AI client talk to each company's SSO directly:

- **One issuer:** Claude and ChatGPT know one authorization server, one token format and one
  client registration, however many client companies CoreCenas adds.
- **Company-specific rules stay in one place:** each company's groups can be mapped to
  platform roles with Keycloak mappers, per identity provider.
- **The company is known for sure:** the token's `company` claim is set by which SSO the person
  signed in with, never by anything the client sends. The MCP server uses it to keep a client
  company's users inside their own tenant, even if someone assigned them elsewhere by mistake.
- **Offboarding follows the company:** when MasIkea disables someone in its SSO, they can't
  sign in to the platform any more (see question 10 for existing sessions).

To add a company, see [Add a client company](#add-a-client-company): one entry in
`directory.json` and `make bootstrap`.

<details>
<summary><b>Example:</b> the email-first redirect, marta's token, and the home-tenant check</summary>

After marta types her email, Keycloak redirects to MasIkea's broker, passing her email
along as a login hint:

```
http://localhost:9080/realms/platform/broker/masikea/login?session_code=Go5uAe6E…&client_id=6db18e02-…&login_hint=marta%40masikea.example
```

…which forwards to MasIkea's SSO (the `masikea-entra` realm), where she types her password.
After the round trip, her access token from realm `platform` (decoded):

```json
{
  "iss": "http://localhost:9080/realms/platform",
  "aud": ["platform-mcp-server", "http://localhost:9080/mcp"],
  "sub": "4d9425b7-d6f9-4186-89b7-59f0d5eec7b0",
  "scope": "platform:read offline_access platform:write",
  "name": "Marta Moura",
  "email": "marta@masikea.example",
  "principal_type": "customer_user",
  "company": "masikea"
}
```

marta asks for her own tenant, then for VodaFundas':

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_campaigns","arguments":{"tenant_id":1001}}}
```

```json
{"result":{"content":[{"type":"text","text":"[{\"id\":501,\"name\":\"Black Friday reactivation\",\"status\":\"running\",\"type\":\"outbound-voice\"},{\"id\":502,\"name\":\"Loyalty NPS survey\",…}]"}]},"jsonrpc":"2.0","id":3}
```

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_campaigns","arguments":{"tenant_id":1002}}}
```

```json
{"result":{"content":[{"type":"text","text":"Denied: tenant 1002 (VodaFundas) belongs to another company; you can only work in your own company's tenant"}],"isError":true},"jsonrpc":"2.0","id":4}
```

</details>

### 5. What is token exchange, and why doesn't the MCP server just forward the user's token?

**Token exchange (RFC 8693)** is a standard call to Keycloak's token endpoint: "here is the
user's token, give me a different token for a different purpose". The MCP server (client
`platform-mcp-server`) sends the user's token as `subject_token` and asks for scopes
`tenant-1001 role-supervisor`. Keycloak returns an internal token with:

- `aud: platform-backend`: only the backends accept it
- `tenant_id: 1001` and `role: supervisor`: exactly one tenant, the one just authorized
- `act: { sub: "platform-mcp-server" }`: shows the MCP server acted for the person
- a 5-minute lifetime

Why not forward the user's token:

- **The spec forbids it** ("token passthrough"): a token must only be used at the resource
  it was issued for.
- **Least privilege:** the user's token works for every tenant they're assigned to. The
  internal token works for one tenant, for five minutes. A leaked internal token does far
  less damage.
- **The backend doesn't have to trust the MCP server's word.** The tenant is inside a token
  Keycloak signed, so a bug or a misrouted request can't claim another tenant.

The MCP server caches each internal token per (person, tenant, role) until 30 seconds before
it expires, and never reuses one across tenants. Code: `internalToken()` in
`mcp-server/src/backend.ts`; the token check in `backend/server.mjs`.

<details>
<summary><b>Example:</b> the exchange, the internal token, and the backend's answers</summary>

What the MCP server sends to Keycloak (inside the Docker network):

```http
POST /realms/platform/protocol/openid-connect/token HTTP/1.1
Host: keycloak:8080
Authorization: Basic cGxhdGZvcm0tbWNwLXNlcnZlcjo…   (platform-mcp-server + its secret)
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=eyJ…   (alice's access token)
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&scope=tenant-1001 role-supervisor
```

```json
{
  "access_token": "eyJ…",
  "expires_in": 300,
  "token_type": "Bearer",
  "scope": "tenant-1001 role-supervisor",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token"
}
```

The internal token, decoded:

```json
{
  "iss": "http://localhost:9080/realms/platform",
  "aud": "platform-backend",
  "sub": "de4a1552-3ccc-4765-be99-e8ce1667e86f",
  "azp": "platform-mcp-server",
  "scope": "tenant-1001 role-supervisor",
  "tenant_id": 1001,
  "role": "supervisor",
  "act": { "sub": "platform-mcp-server" },
  "iat": 1790277724,
  "exp": 1790278024
}
```

The MCP server then calls the backend with it:

```http
GET /campaign HTTP/1.1
Host: portal-api:4000
Authorization: Bearer eyJ…   (the internal token)
```

```http
HTTP/1.1 200 OK

[{"id":501,"name":"Black Friday reactivation","status":"running","type":"outbound-voice"},
 {"id":502,"name":"Loyalty NPS survey","status":"paused","type":"sms"}]
```

The same call with alice's *own* access token, and with no token:

```http
HTTP/1.1 401 Unauthorized

{"error":"invalid internal token: unexpected \"aud\" claim value"}
```

```http
HTTP/1.1 401 Unauthorized

{"error":"missing internal token"}
```

</details>

### 6. If the MCP server validates the token, why does APISIX validate it too? And why not let the gateway inject a trusted `X-Tenant-ID` header?

**Each check guards against a different failure.** APISIX checks cheaply at the edge, so
junk and expired tokens never cost MCP server capacity, and one gateway can protect many
services the same way. The MCP server checks because it makes the authorization decision
and must not depend on how traffic reached it (a misconfigured route, an internal caller).
The backends check because they hold the data.

**No trusted headers** because a header is only as trustworthy as the network path. If the
backends believed `X-Tenant-ID`, then anything that can reach them from inside (a
misrouted request, a compromised container, a bug) could name any tenant by setting a header.
A signed internal token can't be forged that way. APISIX actively **strips** such headers
from incoming requests (`proxy-rewrite` in the `edge` plugin config), so nobody can try.

<details>
<summary><b>Example:</b> the three checks, as they answer</summary>

| Check | Request | Answer |
| --- | --- | --- |
| APISIX | forged token on `/mcp` | `401` + `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"` |
| MCP server | tenant in another zone | `Denied: tenant 2001 (Initech Bank) is served by zone eu2; use the mcpeu2 server` |
| Backend | user's own token instead of the internal one | `401 {"error":"invalid internal token: unexpected \"aud\" claim value"}` |

The stripped headers (`apisix/apisix.yaml`, plugin config `edge`):

```yaml
proxy-rewrite:
  headers:
    remove: [X-Tenant-ID, X-Company, X-User, X-User-Id, X-Userinfo, X-Access-Token,
             X-ID-Token, X-Forwarded-User, X-Remote-User, X-Auth-Request-User]
```

</details>

### 7. Why are there two `/mcp` routes in APISIX, and what does `response-rewrite` fix?

Because the MCP login only starts if the 401 response carries the right
`WWW-Authenticate` header (question 1), and APISIX's `openid-connect` plugin doesn't produce
that header on its own.

- **`mcp-authenticated`** matches only requests with an `Authorization: Bearer …` header. It
  runs `openid-connect` to check the token at the edge. If the token is bad (expired, wrong
  audience), the plugin answers 401, and **`response-rewrite`** replaces its header with
  `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…", scope="…"`, so the
  client knows to refresh or log in again.
- **`mcp-anonymous`** catches requests with no token and passes them straight to the MCP
  server, which answers with the correct challenge that starts the login.

Both routes still get the rate limit and size limit. See `apisix/apisix.yaml`, or the
**Routes** page in the APISIX dashboard.

<details>
<summary><b>Example:</b> the same URL, with and without a token</summary>

No token → forwarded to the MCP server, which starts the login:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="http://localhost:9080/.well-known/oauth-protected-resource/mcp", scope="platform:read platform:write offline_access"
```

Bad token → stopped by APISIX; `response-rewrite` adds `error="invalid_token"` and the
metadata pointer:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", resource_metadata="http://localhost:9080/.well-known/oauth-protected-resource/mcp", scope="platform:read platform:write offline_access"
```

The matching rule on `mcp-authenticated`:

```yaml
vars: [["http_authorization", "~*", "^bearer "]]
```

</details>

### 8. Why isn't the list of tenants a person may use stored in the token?

Because tokens are **snapshots**: whatever is inside stays true until the token expires.

- **Stale access:** if the tenant list were in the token, removing an assignment wouldn't take
  effect until the token expired. Refresh tokens can live much longer.
- **Size:** staff can have many assignments, and tokens travel on every request.
- **Separation of concerns:** Keycloak knows *who* you are (and which company you belong to);
  the assignment store knows *where* you may go, with which role, until when, and who
  approved it.

So the token carries only stable, coarse facts (who, which company, which app,
`platform:read` / `platform:write`), and the MCP server looks up the assignment on **every
call**. Lookups are cached for 60 seconds per (person, tenant), so an assignment change
takes effect within a minute.

The trade-off: one database lookup per call (mostly served from the cache), and the MCP
server depends on the store being available. Code: `getAssignment()` in `mcp-server/src/store.ts`.

<details>
<summary><b>Example:</b> the token's scopes decide which tools exist; the store decides where</summary>

`tools/list` for a full token returns 17 tools. One of them, as the client sees it:

```json
{
  "name": "start_campaign",
  "title": "Start campaign",
  "description": "Start (or resume) a campaign; it will contact real customers. Two steps: plan, then execute with confirmation_id after the user explicitly agrees. [risk tier T3]",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tenant_id": { "type": "integer", "exclusiveMinimum": 0, "description": "Tenant id; see get_my_context" },
      "campaign_id": { "type": "integer", "exclusiveMinimum": 0 },
      "confirmation_id": { "type": "string", "description": "Omit on the first call; pass the id returned by the plan to execute" }
    },
    "required": ["tenant_id", "campaign_id"]
  },
  "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true }
}
```

With a `platform:read`-only token, write tools aren't listed, and calling one anyway is
refused at the HTTP level (step-up):

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer resource_metadata="http://localhost:9080/.well-known/oauth-protected-resource/mcp", scope="platform:read platform:write", error="insufficient_scope", error_description="start_campaign needs platform:write"
```

A valid token but no active assignment (bob's expired one):

```text
Denied: no active assignment to tenant 1002
```

</details>

### 9. How does plan → execute work, and what stops the AI from reusing a confirmation?

Tools that change data (tiers T2 and T3) run in two steps:

1. **Plan:** the first call doesn't change anything. It returns what would happen (target
   tenant, objects, effect, count, estimated cost) plus a `confirmation_id`.
2. **Execute:** the AI shows the plan to the user and, once they agree, calls the same tool
   again with exactly the same arguments plus that `confirmation_id`.

The `confirmation_id` is built so it can't be reused:

- **Signed** with HMAC using a key only the MCP server has, so it can't be forged. It's
  *not* encrypted: anyone can read what's inside (see the example), but changing it breaks
  the signature.
- **Bound** to the person, the tenant, the tool and a hash of the arguments. Changing
  campaign 502 to 501 fails with *"arguments changed since the plan"*.
- **Expires** after 5 minutes.
- **Single use:** its id is recorded in Postgres (`confirmations_used`) on execute, so a
  replay fails with *"already used"*, even across several MCP server copies.

What it doesn't guarantee: that the AI really asked the user. A model could call execute
right after the plan. T3 plans instruct the AI to restate the plan and get an explicit yes,
and every plan and execute is audited. A client that supports MCP *elicitation* could put a
real confirmation dialog in front of the user; the lab doesn't use that yet. Code:
`issueConfirmation()` / `verifyConfirmation()` in `mcp-server/src/guards.ts`.

<details>
<summary><b>Example:</b> plan, a changed execute, the real execute, a replay, and the audit trail</summary>

1 — Plan (alice, pausing campaign 502 in MasIkea):

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"pause_campaign","arguments":{"tenant_id":1001,"campaign_id":502}}}
```

```json
{
  "status": "confirmation_required",
  "tenant": "MasIkea (tenant 1001)",
  "summary": "Pause campaign 502 in MasIkea",
  "effect": "Stops new contact attempts until started again.",
  "count": 1,
  "confirmation_id": "eyJqdGkiOiIyMjAzMmJiZi00NmNmLTRmODYt….k0TJyTH20AdRkdpJvGudeN3DPtUimriXUojsw8WcBlQ",
  "expires_at": "2026-09-24T19:27:04.279Z",
  "next_step": "Restate this plan to the user in your own words and get their explicit yes. Then call pause_campaign again with exactly the same arguments plus confirmation_id."
}
```

The part of the `confirmation_id` before the dot, base64-decoded. After the dot is the
HMAC signature:

```json
{
  "jti": "22032bbf-46cf-4f86-92a9-6571b34a1164",
  "sub": "de4a1552-3ccc-4765-be99-e8ce1667e86f",
  "w": 1001,
  "tool": "pause_campaign",
  "h": "9e629ffd08e6c4bb83d7d171cffc79d16196dc41e4b92fd20a2ff1749a606750",
  "exp": 1790278024279
}
```

2 — Execute with a different campaign (`"campaign_id": 501` + the same `confirmation_id`):

```text
Denied: arguments changed since the plan; request a new plan
```

3 — Execute with the planned arguments:

```json
{ "id": 502, "previous": "running", "status": "paused" }
```

4 — The same execute again:

```text
Denied: confirmation_id already used
```

The four audit rows (`make audit`, newest first; confirmation ids are stored as a short prefix):

| ts | email | tenant | tool | tier | args | outcome | reason | backend route |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 19:22:04.292 | alice@corecenas.example | 1001 | pause_campaign | T3 | campaign 502 | denied | confirmation_id already used | — |
| 19:22:04.288 | alice@corecenas.example | 1001 | pause_campaign | T3 | campaign 502 | allowed | — | portal-api POST /campaign/502/pause |
| 19:22:04.283 | alice@corecenas.example | 1001 | pause_campaign | T3 | campaign 501 | denied | arguments changed since the plan | — |
| 19:22:04.279 | alice@corecenas.example | 1001 | pause_campaign | T3 | campaign 502 | planned | — | — |

</details>

### 10. If I revoke someone's access, how long until it takes effect?

It depends on what you revoke. The key fact: **the MCP server validates access tokens
locally** (signature and expiry). It doesn't ask Keycloak on every call, so an access token
that was already issued keeps working until it expires, at most **10 minutes**.

| Action | Effect on tool calls | Where |
| --- | --- | --- |
| Remove or expire an **assignment** | **Within 60 s** for that tenant (assignment cache). Fastest way to cut tenant access | `directory.json` + `make bootstrap` |
| **Revoke consent** for the app | Refresh and offline tokens stop working now; the current access token works for up to 10 min | Keycloak → Users → user → Consents |
| **Disable the user** in realm `platform` | Next refresh fails (*User disabled*); up to 10 min | Keycloak → Users |
| **Disable the user** in their company's SSO realm only | Blocks new logins, but **not** an existing session: Keycloak doesn't recheck the upstream on refresh | Keycloak, the company realm |

For a complete offboarding: remove the assignments (cuts tenant access within a minute), then
disable the user in realm `platform` and in their company's SSO. To shrink the 10-minute
window, lower `accessTokenLifespan` in `bootstrap/bootstrap.mjs`. The trade-off is more
frequent refreshes.

<details>
<summary><b>Example:</b> refresh token rotation and what a cut-off client sees</summary>

A refresh returns a new access token *and* a new refresh token:

```http
POST /realms/platform/protocol/openid-connect/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&refresh_token=eyJ…&client_id=216a574b-edd5-4579-a33d-7a343329b994
```

```json
{
  "access_token": "eyJ…",
  "expires_in": 600,
  "refresh_token": "eyJ…",
  "token_type": "Bearer",
  "scope": "platform:read offline_access platform:write"
}
```

Using the *old* refresh token again (rotation: each one works once):

```http
HTTP/1.1 400 Bad Request

{"error":"invalid_grant","error_description":"Maximum allowed refresh token reuse exceeded"}
```

Refreshing after the user was disabled in realm `platform`:

```http
HTTP/1.1 400 Bad Request

{"error":"invalid_grant","error_description":"User disabled"}
```

</details>

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Claude Desktop: server disconnected, log shows `SyntaxError: Unexpected end of input` in `mcp-remote` | The `npx` download got corrupted (two starts raced). Quit Claude Desktop, run `rm -rf ~/.npm/_npx`, then `npx -y mcp-remote --help` once, then reopen |
| `Policy 'Trusted Hosts' rejected request` | Add the host to `dcrTrustedHosts` ([details](#allow-a-new-ai-client-to-register)) |
| Claude Desktop keeps failing after a `make reset` or `make tunnel` | The bridge is reusing a registration Keycloak no longer knows. Quit, `rm -rf ~/.mcp-auth`, reopen |
| No `corecenas` entry in Claude Desktop | Quit it (Cmd+Q) *before* editing the config file, then check the file still has `mcpServers.corecenas` |
| The login page asks for a password instead of sending you to your company | The email's domain doesn't match any company in `directory.json`. Use one of the demo emails, or add the company |
| Only read tools show up | The app didn't ask for `platform:write`. Revoke its consent (**Users** → user → **Consents**), delete `~/.mcp-auth` for Claude Desktop, and reconnect. The consent screen should list both *Read* and *Change contact-center platform data* |
| `429` from the gateway while testing | You hit a rate limit, e.g. 10 client registrations per minute per IP. Wait a minute |
| Keycloak admin console spins forever | Run `make bootstrap` (it points the admin login at port 8081) |
| Anything else | Logs: `~/Library/Logs/Claude/mcp-server-corecenas.log` (Claude Desktop), `make logs`, `docker compose logs keycloak`. Audit: `make audit` |

---

## Lab simplifications

- **One zone** (`eu1`). Tenant 2001 is in zone `eu2` and is refused with a pointer to `mcpeu2`.
- **Mocks:** each company's SSO is a Keycloak realm; portal-api and rest-api are small mock
  services with the real auth middleware but fake data.
- **Gateway on etcd:** a Git-managed setup would usually run APISIX in standalone YAML mode.
  The lab uses etcd so the APISIX dashboard can show the config, but `apisix/apisix.yaml`
  is still the source of truth.
- **No Coraza WAF, no OpenTelemetry export, no elicitation** (confirmation is plan → execute only).
- **Audience binding** uses Keycloak's audience-mapper workaround, not RFC 8707 Resource
  Indicators. The mappers sit on `platform:read` / `platform:write`, because a client that
  registers with an explicit scope list (Claude, ChatGPT) gets only those scopes.
- **Company claim** comes from a user attribute set by each company's broker, because
  Keycloak's built-in organization mapper only emits its claim when the client asks for the
  `organization` scope, which MCP clients don't.
- **Registration is DCR only**; the newer CIMD method is off until tested with the real clients.
- **Internal token claims** come from one scope per tenant and per role. That's fine for a
  handful of tenants; at real scale use parameterized scopes or a custom mapper.
- Keycloak runs in dev mode on one node, and secrets are local defaults (override in `.env`).
