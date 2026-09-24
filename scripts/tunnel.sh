#!/usr/bin/env bash
# Expose APISIX on a public HTTPS URL (Cloudflare quick tunnel, no account)
# so claude.ai and ChatGPT, which connect from their cloud, can reach it.
# The URL is random and changes every time the tunnel container restarts.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose --profile tunnel up -d cloudflared
echo "waiting for the tunnel URL..."
url=""
for _ in $(seq 1 60); do
  url=$(docker compose logs cloudflared 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
  [ -n "$url" ] && break
  sleep 1
done
[ -n "$url" ] || { echo "no tunnel URL after 60 s; see: docker compose logs cloudflared" >&2; exit 1; }

./scripts/set-public-url.sh "$url"

echo "waiting for ${url}/mcp to answer through the tunnel..."
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${url}/mcp" || true)
  [ "$code" = "401" ] && break
  sleep 2
done

cat <<MSG

MCP server URL (add this as a custom connector):

    ${url}/mcp

  claude.ai:  Settings > Connectors > Add custom connector
  ChatGPT:    Settings > Apps & Connectors > Advanced > Developer mode, then Create
  Claude Code: claude mcp add --transport http platform ${url}/mcp

Sign in as alice / bob / carol (password: \${DEMO_PASSWORD:-Passw0rd!}).
Stop with: make local
MSG
