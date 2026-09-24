// Syncs apisix.yaml (the Git-managed gateway config) into APISIX through the
// Admin API: PUTs every upstream, plugin config and route in the file, then
// deletes any of those resources that are not in the file, so the file wins
// over edits made in the dashboard.
import { readFile } from "node:fs/promises";
import YAML from "yaml";

const ADMIN = process.env.APISIX_ADMIN_URL ?? "http://apisix:9180/apisix/admin";
const KEY = process.env.APISIX_ADMIN_KEY;
const FILE = process.env.APISIX_CONFIG ?? "/config/apisix.yaml";
// Order matters: routes reference upstreams and plugin configs.
const KINDS = ["upstreams", "plugin_configs", "routes"];

const raw = await readFile(FILE, "utf8");
const text = raw.replace(/\$\{\{(\w+)\}\}/g, (_, name) => {
  if (!(name in process.env)) throw new Error(`${FILE} uses \${{${name}}} but it is not set`);
  return process.env[name];
});
const config = YAML.parse(text);

async function admin(method, path, body) {
  const res = await fetch(`${ADMIN}/${path}`, {
    method,
    headers: { "X-API-KEY": KEY, ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(method === "DELETE" && res.status === 404)) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

for (let i = 0; i < 60; i++) {
  try { await admin("GET", "routes"); break; } catch (e) {
    if (i === 59) throw e;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const summary = {};
for (const kind of KINDS) {
  const items = config[kind] ?? [];
  for (const { id, ...body } of items) await admin("PUT", `${kind}/${id}`, body);
  summary[kind] = items.length;
}

// Remove what is not in the file, in reverse dependency order.
const removed = [];
for (const kind of [...KINDS].reverse()) {
  const wanted = new Set((config[kind] ?? []).map((i) => String(i.id)));
  const { list = [] } = await admin("GET", kind);
  for (const { value } of list) {
    if (!wanted.has(String(value.id))) {
      await admin("DELETE", `${kind}/${value.id}`);
      removed.push(`${kind}/${value.id}`);
    }
  }
}

console.log(JSON.stringify({ ok: true, synced: summary, removed }));
