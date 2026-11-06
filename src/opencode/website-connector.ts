/**
 * The original Codex harness connects its "Codex Native2" website plugin to
 * the native MCP contract. OpenCode uses the same Electron/tunnel transport,
 * but a separate plugin name and MCP contract so website calls reach only the
 * tools authenticated for their originating OpenCode turn.
 */
export const OPENCODE_WEBSITE_CONNECTOR_NAME = "opencode-chatgpt-web";
/** The isolated DEV harness keeps the upstream `${name} DEV` connector convention. */
export const OPENCODE_WEBSITE_CONNECTOR_DEV_NAME = `${OPENCODE_WEBSITE_CONNECTOR_NAME} DEV`;

export type WebsiteConnectorProfile = "production" | "development";

export function openCodeWebsiteConnectorName(profile: WebsiteConnectorProfile): string {
  return profile === "development" ? OPENCODE_WEBSITE_CONNECTOR_DEV_NAME : OPENCODE_WEBSITE_CONNECTOR_NAME;
}

export function isOpenCodeWebsiteConnectorName(value: string): boolean {
  return value === OPENCODE_WEBSITE_CONNECTOR_NAME || value === OPENCODE_WEBSITE_CONNECTOR_DEV_NAME;
}

export type WebsiteMcpContract = "opencode";

export function resolveWebsiteMcpContract(config: {
  websiteMcpContract?: WebsiteMcpContract;
  browserInteractionMode: "automatic" | "manual";
}): "native" | "safe" | "opencode" {
  if (config.websiteMcpContract === "opencode") {
    if (config.browserInteractionMode !== "automatic") {
      throw new Error("OpenCode website tools require automatic browser interaction");
    }
    return "opencode";
  }
  return config.browserInteractionMode === "manual" ? "safe" : "native";
}
