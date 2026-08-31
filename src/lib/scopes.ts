/**
 * Coarse on purpose. Fine-grained scopes a user cannot reason about are worse
 * than none. See docs/03-agent-interface.md section 2.
 */
export const MCP_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "profile:read",
  "profile:write",
  "recipes:read",
  "recipes:write",
  "plan:read",
  "plan:write",
  "pantry:read",
  "pantry:write",
  "feedback:read",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];
