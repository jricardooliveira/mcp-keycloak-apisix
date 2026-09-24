.PHONY: up down reset test test-readonly tunnel local logs audit assignments claude gateway-sync bootstrap

up: ## Build and start everything on http://localhost:9080
	@test -f .env || echo "PUBLIC_URL=http://localhost:9080" > .env
	docker compose up -d --build --wait apisix api-docs rest-api portal-api
	docker compose up --build --exit-code-from gateway-seed gateway-seed
	@echo
	@echo "MCP server:   $$(grep ^PUBLIC_URL .env | cut -d= -f2)/mcp"
	@echo "Keycloak UI:  http://localhost:8081  (admin / admin)"
	@echo "API docs:     http://localhost:8082  (mock portal-api / rest-api)"
	@echo "Gateway UI:   http://localhost:9180/ui  (admin key: local-apisix-admin-key)"
	@echo "Claude Code:  make claude"

down: ## Stop (keeps data)
	docker compose --profile tunnel down

reset: ## Stop and delete all data
	docker compose --profile tunnel down -v

test: ## End-to-end: DCR, PKCE login via mock Entra, consent, MCP calls
	node tests/e2e.mjs alice@corecenas.example
	node tests/e2e.mjs bob@corecenas.example
	node tests/e2e.mjs marta@masikea.example
	node tests/e2e.mjs vasco@vodafundas.example

test-readonly: ## Same with a platform:read-only token (403 step-up)
	E2E_SCOPE=platform:read node tests/e2e.mjs alice@corecenas.example

tunnel: ## Public HTTPS URL for claude.ai / ChatGPT
	./scripts/tunnel.sh

local: ## Stop the tunnel and go back to http://localhost:9080
	docker compose --profile tunnel stop cloudflared
	docker compose --profile tunnel rm -f cloudflared
	./scripts/set-public-url.sh http://localhost:9080

bootstrap: ## Apply bootstrap/directory.json (tenants, staff, assignments, DCR hosts) + Keycloak config
	docker compose up --build --force-recreate --exit-code-from bootstrap bootstrap

gateway-sync: ## Reload apisix/apisix.yaml into the gateway (undoes dashboard edits)
	docker compose up --build --force-recreate --exit-code-from gateway-seed gateway-seed

logs: ## Follow MCP server + gateway logs
	docker compose logs -f mcp-server apisix

audit: ## Last 30 audit records
	docker compose exec -T postgres psql -U platform -d platform -c "SELECT to_char(ts,'MM-DD HH24:MI:SS') ts, email, tenant_id w, tool, tier, outcome, left(reason,60) reason, backend_route FROM audit_log ORDER BY id DESC LIMIT 30;"

assignments: ## Who may work in which tenant
	docker compose exec -T postgres psql -U platform -d platform -c "SELECT p.username, a.tenant_id, t.name tenant, t.zone, a.role, a.expires_at, a.reason FROM assignments a JOIN principals p USING (subject) JOIN tenants t USING (tenant_id) ORDER BY 1, 2;"

claude: ## Add this MCP server to Claude Code
	claude mcp add --transport http corecenas "$$(grep ^PUBLIC_URL .env | cut -d= -f2)/mcp"
	@echo "Then run /mcp in Claude Code and choose corecenas > Authenticate."
