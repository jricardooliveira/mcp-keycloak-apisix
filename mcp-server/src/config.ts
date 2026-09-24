function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing env ${name}`);
  return value;
}

const publicUrl = env("PUBLIC_URL").replace(/\/$/, "");
const keycloak = env("KEYCLOAK_INTERNAL_URL");
const zone = env("MCP_ZONE", "eu1");

export const config = {
  port: Number(env("PORT", "3000")),
  zone,
  serverName: `platform-mcp-${zone}`,
  publicUrl,
  // Canonical MCP URL: the only audience this server accepts.
  resource: `${publicUrl}/mcp`,
  resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource/mcp`,
  issuer: `${publicUrl}/realms/platform`,
  jwksUrl: `${keycloak}/realms/platform/protocol/openid-connect/certs`,
  tokenUrl: `${keycloak}/realms/platform/protocol/openid-connect/token`,
  exchangeClientId: env("MCP_TOKEN_EXCHANGE_CLIENT_ID"),
  exchangeClientSecret: env("MCP_TOKEN_EXCHANGE_SECRET"),
  confirmationKey: env("CONFIRMATION_SIGNING_KEY"),
  databaseUrl: env("DATABASE_URL"),
  redisUrl: env("REDIS_URL"),
  restApiUrl: env("REST_API_URL"),
  portalApiUrl: env("PORTAL_API_URL"),
  scopesSupported: ["platform:read", "platform:write", "offline_access"],
  // Scopes requested in the 401 challenge so first login covers all tools.
  challengeScope: "platform:read platform:write offline_access",
};
