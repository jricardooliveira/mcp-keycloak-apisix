// Mock portal-api (SERVICE=portal-api) and rest-api /1.0/ (SERVICE=rest-api).
// The business logic is fake; the part that mirrors the design is the auth
// middleware: it accepts only Keycloak-exchanged internal JWTs and pins every
// request to the single tenant in the token. There is no way to name a
// tenant in the URL or a header.
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SERVICE = process.env.SERVICE ?? "rest-api";
const ISSUER = `${process.env.PUBLIC_URL.replace(/\/$/, "")}/realms/platform`;
const JWKS = createRemoteJWKSet(new URL(`${process.env.KEYCLOAK_INTERNAL_URL}/realms/platform/protocol/openid-connect/certs`));

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true, service: SERVICE }));

// --- internal JWT middleware -------------------------------------------------
app.use(async (req, res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return res.status(401).json({ error: "missing internal token" });
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: "platform-backend", algorithms: ["RS256"] });
    if (!Number.isInteger(payload.tenant_id)) throw new Error("token not pinned to a tenant");
    if (payload.act?.sub !== "platform-mcp-server") throw new Error("missing act claim");
    req.ctx = { subject: payload.sub, tenantId: payload.tenant_id, role: payload.role, actor: payload.act.sub };
    next();
  } catch (e) {
    res.status(401).json({ error: `invalid internal token: ${e.message}` });
  }
});

// --- fake per-tenant data ----------------------------------------------------
const data = {
  1001: {
    name: "Acme Retail", timezone: "Europe/Lisbon", languages: ["pt", "en"],
    skills: [
      { id: 11, name: "Sales PT", channel: "voice", agents: 14, queue: 3 },
      { id: 12, name: "Support EN", channel: "chat", agents: 9, queue: 7 },
    ],
    campaigns: [
      { id: 501, name: "Black Friday reactivation", status: "paused", type: "outbound-voice", contacts: 12400, reached: 3100, converted: 410 },
      { id: 502, name: "Loyalty NPS survey", status: "running", type: "sms", contacts: 8000, reached: 7400, converted: 2250 },
    ],
    segments: [
      { id: "seg-vip", name: "VIP customers", rule: "lifetime_value > 5000", size: 820 },
      { id: "seg-churn", name: "Churn risk", rule: "last_purchase_days > 180", size: 3140 },
    ],
    customers: [
      { id: "c-1", name: "Maria Santos", email: "maria.santos@example.com", phone: "+351910000001", segment: "seg-vip", lifetime_value: 7200 },
      { id: "c-2", name: "João Pereira", email: "joao.pereira@example.com", phone: "+351910000002", segment: "seg-churn", lifetime_value: 310 },
      { id: "c-3", name: "Ana Rodrigues", email: "ana.rodrigues@example.com", phone: "+351910000003", segment: "seg-vip", lifetime_value: 9100 },
    ],
    leads: [{ id: "l-900", name: "Rui Costa", phone: "+351910000009", source: "web-form", status: "new" }],
    settings: { callback_window_hours: 24, sms_sender_id: "ACME" },
    blacklist: [],
  },
  1002: {
    name: "Globex Telecom", timezone: "Europe/Madrid", languages: ["es", "en"],
    skills: [{ id: 21, name: "Retention ES", channel: "voice", agents: 30, queue: 12 }],
    campaigns: [{ id: 601, name: "5G upgrade", status: "draft", type: "outbound-voice", contacts: 50000, reached: 0, converted: 0 }],
    segments: [{ id: "seg-prepaid", name: "Prepaid users", rule: "plan = 'prepaid'", size: 21000 }],
    customers: [{ id: "c-10", name: "Lucía García", email: "lucia.garcia@example.com", phone: "+34600000010", segment: "seg-prepaid", lifetime_value: 540 }],
    leads: [],
    settings: { callback_window_hours: 48, sms_sender_id: "GLOBEX" },
    blacklist: [],
  },
  2001: {
    name: "Initech Bank", timezone: "America/Sao_Paulo", languages: ["pt"],
    skills: [], campaigns: [], segments: [], customers: [], leads: [], settings: {}, blacklist: [],
  },
};
const t = (req) => data[req.ctx.tenantId] ?? (data[req.ctx.tenantId] = { skills: [], campaigns: [], segments: [], customers: [], leads: [], settings: {}, blacklist: [] });
const notFound = (res, what) => res.status(404).json({ error: `${what} not found` });
let seq = 1000;

if (SERVICE === "rest-api") {
  const r = express.Router();
  r.get("/skill", (req, res) => res.json(t(req).skills));
  r.get("/skill/:id/schedule", (req, res) => {
    const s = t(req).skills.find((x) => x.id === Number(req.params.id));
    if (!s) return notFound(res, "skill");
    res.json({ skill: s.id, timezone: t(req).timezone, week: { mon_fri: "08:00-20:00", sat: "09:00-13:00", sun: "closed" } });
  });
  r.get("/segment", (req, res) => res.json(t(req).segments));
  r.post("/segment", (req, res) => {
    const { id, name, rule } = req.body;
    const segs = t(req).segments;
    const existing = segs.find((s) => s.id === id);
    if (existing) Object.assign(existing, { name, rule });
    const seg = existing ?? { id: id ?? `seg-${++seq}`, name, rule, size: Math.floor(Math.random() * 5000) };
    if (!existing) segs.push(seg);
    res.status(existing ? 200 : 201).json(seg);
  });
  r.get("/customers", (req, res) => {
    const q = String(req.query.q ?? "").toLowerCase();
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    res.json(t(req).customers.filter((c) => !q || c.name.toLowerCase().includes(q) || c.email.includes(q) || c.phone.includes(q)).slice(0, limit));
  });
  r.get("/customers/:id", (req, res) => {
    const c = t(req).customers.find((x) => x.id === req.params.id);
    c ? res.json(c) : notFound(res, "customer");
  });
  r.get("/leads/:id", (req, res) => {
    const l = t(req).leads.find((x) => x.id === req.params.id);
    l ? res.json(l) : notFound(res, "lead");
  });
  r.post("/form2lead", (req, res) => {
    const lead = { id: `l-${++seq}`, status: "new", source: "mcp", ...req.body };
    t(req).leads.push(lead);
    res.status(201).json(lead);
  });
  r.post("/blacklists", (req, res) => {
    t(req).blacklist.push({ phone: req.body.phone, reason: req.body.reason, by: req.ctx.subject });
    res.status(201).json({ blacklisted: req.body.phone });
  });
  r.post("/sms/send", (req, res) => {
    if (t(req).blacklist.some((b) => b.phone === req.body.to)) return res.status(409).json({ error: "recipient is blacklisted" });
    res.status(202).json({ message_id: `sms-${++seq}`, to: req.body.to, sender: t(req).settings.sms_sender_id, status: "queued" });
  });
  app.use("/1.0", r);
} else {
  app.get("/client/config", (req, res) => {
    const d = t(req);
    res.json({ tenant_id: req.ctx.tenantId, name: d.name, timezone: d.timezone, languages: d.languages, settings: d.settings });
  });
  app.put("/client/settings/:key", (req, res) => {
    const d = t(req);
    if (!(req.params.key in d.settings)) return notFound(res, "setting");
    const previous = d.settings[req.params.key];
    d.settings[req.params.key] = req.body.value;
    res.json({ key: req.params.key, previous, value: req.body.value });
  });
  app.get("/stats/global", (req, res) => {
    const skills = t(req).skills;
    res.json({ agents_online: skills.reduce((a, s) => a + s.agents, 0), contacts_waiting: skills.reduce((a, s) => a + s.queue, 0), by_skill: skills.map(({ id, name, queue }) => ({ id, name, queue })) });
  });
  app.get("/campaign", (req, res) => res.json(t(req).campaigns.map(({ id, name, status, type }) => ({ id, name, status, type }))));
  app.get("/campaign/:id/stats", (req, res) => {
    const c = t(req).campaigns.find((x) => x.id === Number(req.params.id));
    if (!c) return notFound(res, "campaign");
    res.json({ id: c.id, contacts: c.contacts, reached: c.reached, converted: c.converted, conversion_rate: c.reached ? +(c.converted / c.reached).toFixed(3) : 0 });
  });
  for (const action of ["start", "pause"]) {
    app.post(`/campaign/:id/${action}`, (req, res) => {
      const c = t(req).campaigns.find((x) => x.id === Number(req.params.id));
      if (!c) return notFound(res, "campaign");
      const previous = c.status;
      c.status = action === "start" ? "running" : "paused";
      res.json({ id: c.id, previous, status: c.status });
    });
  }
}

app.listen(4000, () => console.log(`${SERVICE} listening on :4000`));
