const CURRENT_CONNECTOR_NAME = "OpenCode Native2";
const DEV_CONNECTOR_NAME = `${CURRENT_CONNECTOR_NAME} DEV`;
// Historical legacy connector names as created by the Codex-branded releases.
// Detection must keep matching real pre-existing ChatGPT plugins — do not rename.
const LEGACY_CONNECTOR_NAMES = Object.freeze(["Codex Native"]);
const OPENCODE_CONNECTOR_NAME = "opencode-chatgpt-web";
const OPENCODE_DEV_CONNECTOR_NAME = `${OPENCODE_CONNECTOR_NAME} DEV`;

function openCodeConnectorName(profile) {
  if (profile !== "production" && profile !== "development") {
    throw new Error("OpenCode connector name requires a known launcher profile");
  }
  return profile === "development" ? OPENCODE_DEV_CONNECTOR_NAME : OPENCODE_CONNECTOR_NAME;
}

function isOpenCodeConnectorName(value) {
  return value === OPENCODE_CONNECTOR_NAME || value === OPENCODE_DEV_CONNECTOR_NAME;
}

function validateConnectorNameSuffix(value) {
  if (typeof value !== "string" || value.length > 71
    || !/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(value)
    || value !== value.trim()) {
    throw new Error("The part after OpenCode must contain 1–71 letters, numbers, spaces, hyphens or underscores");
  }
  if (value === "Native") throw new Error("OpenCode Native is retired; choose another plugin name");
  return value;
}

function validateConnectorName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 80) {
    throw new Error("Connector name is invalid");
  }
  return value.trim();
}

function isLegacyConnectorName(value) {
  return LEGACY_CONNECTOR_NAMES.includes(value);
}

function connectorNameForSetup(value) {
  const configured = validateConnectorName(value);
  return isLegacyConnectorName(configured) ? CURRENT_CONNECTOR_NAME : configured;
}

function connectorNameForDevSetup(value) {
  if (value === undefined || value === null) return DEV_CONNECTOR_NAME;
  const configured = validateConnectorName(value);
  if (configured === CURRENT_CONNECTOR_NAME || isLegacyConnectorName(configured)) {
    return DEV_CONNECTOR_NAME;
  }
  return configured;
}

function requireCurrentRuntimeConnectorName(value) {
  const configured = validateConnectorName(value);
  if (isLegacyConnectorName(configured)) {
    throw new Error(
      `The local runtime still targets legacy ChatGPT connector ${JSON.stringify(configured)}. Reconnect the harness`
      + ` so it targets ${JSON.stringify(CURRENT_CONNECTOR_NAME)}, then create that connector as a new ChatGPT plugin;`
      + ` do not rename or refresh the legacy connector.`,
    );
  }
  return configured;
}

module.exports = {
  connectorNameForSetup,
  connectorNameForDevSetup,
  CURRENT_CONNECTOR_NAME,
  DEV_CONNECTOR_NAME,
  isLegacyConnectorName,
  isOpenCodeConnectorName,
  LEGACY_CONNECTOR_NAMES,
  openCodeConnectorName,
  OPENCODE_CONNECTOR_NAME,
  OPENCODE_DEV_CONNECTOR_NAME,
  requireCurrentRuntimeConnectorName,
  validateConnectorName,
  validateConnectorNameSuffix,
};
