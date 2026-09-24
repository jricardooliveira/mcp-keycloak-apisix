-- Keycloak gets its own database on the same Postgres.
CREATE DATABASE keycloak OWNER platform;

\connect platform

-- Tenants and the zone that serves them.
CREATE TABLE tenants (
  tenant_id integer PRIMARY KEY,
  name      text NOT NULL,
  zone      text NOT NULL,
  company   text  -- Organization alias of the client company that owns it
);

-- Principals known to the store, keyed on the Platform AS subject (never the Entra oid).
CREATE TABLE principals (
  subject        text PRIMARY KEY,
  username       text NOT NULL,
  email          text,
  principal_type text NOT NULL CHECK (principal_type IN ('staff', 'customer_user', 'machine'))
);

-- subject -> tenant -> role, with expiry and provenance. ROOT has no meaning here.
CREATE TABLE assignments (
  subject     text    NOT NULL REFERENCES principals(subject) ON DELETE CASCADE,
  tenant_id  integer NOT NULL REFERENCES tenants(tenant_id),
  role        text    NOT NULL CHECK (role IN ('viewer', 'support_operator', 'supervisor', 'admin')),
  expires_at  timestamptz,
  assigned_by text    NOT NULL,
  reason      text    NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, tenant_id)
);

-- Every assignment change is audited.
CREATE TABLE assignment_changes (
  id         bigserial PRIMARY KEY,
  changed_at timestamptz NOT NULL DEFAULT now(),
  op         text NOT NULL,
  old_row    jsonb,
  new_row    jsonb
);

CREATE FUNCTION log_assignment_change() RETURNS trigger AS $$
BEGIN
  INSERT INTO assignment_changes(op, old_row, new_row)
  VALUES (TG_OP,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER assignments_audit AFTER INSERT OR UPDATE OR DELETE ON assignments
  FOR EACH ROW EXECUTE FUNCTION log_assignment_change();

-- One record per tool call, reads included. Never tokens, full PII or prompts.
CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  ts              timestamptz NOT NULL DEFAULT now(),
  request_id      text NOT NULL,
  subject         text,
  email           text,
  principal_type  text,
  client_id       text,
  mcp_server      text NOT NULL,
  tenant_id      integer,
  tool            text NOT NULL,
  tier            text,
  args_hash       text,
  args_redacted   jsonb,
  confirmation_id text,
  outcome         text NOT NULL,  -- allowed | planned | denied | error
  reason          text,
  backend_route   text,
  latency_ms      integer
);
CREATE INDEX audit_log_tenant_ts ON audit_log (tenant_id, ts DESC);
CREATE INDEX audit_log_subject_ts ON audit_log (subject, ts DESC);

-- Single-use confirmation ids (plan -> execute), shared by all MCP replicas.
CREATE TABLE confirmations_used (
  id      text PRIMARY KEY,
  used_at timestamptz NOT NULL DEFAULT now()
);

-- Tenants, principals and assignments are synced from bootstrap/directory.json.
