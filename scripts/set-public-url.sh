#!/usr/bin/env bash
# Point the whole stack at a new public URL: rewrites PUBLIC_URL in .env,
# recreates the services that bake it in (Keycloak issuer, MCP canonical URL),
# re-runs the idempotent bootstrap and re-seeds the gateway routes.
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:?usage: set-public-url.sh <url>}"
url="${url%/}"

if grep -q '^PUBLIC_URL=' .env 2>/dev/null; then
  sed -i.bak "s#^PUBLIC_URL=.*#PUBLIC_URL=${url}#" .env && rm -f .env.bak
else
  echo "PUBLIC_URL=${url}" >> .env
fi

echo "PUBLIC_URL=${url}"
docker compose up -d --build --wait keycloak
docker compose up --build --force-recreate --exit-code-from bootstrap bootstrap
docker compose up -d --build --wait mcp-server rest-api portal-api apisix api-docs
# Routes embed PUBLIC_URL (issuer + audience checks): re-seed the gateway.
docker compose up --build --force-recreate --exit-code-from gateway-seed gateway-seed
