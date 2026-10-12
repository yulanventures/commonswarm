// Discovery scopes for a renewable MCP connection. Only mcp grants resource access;
// offline_access lets consenting public clients receive a refresh token.
export const MCP_CONNECTION_SCOPES = Object.freeze(["mcp", "offline_access"]);
