const fs = require("fs/promises");
const path = require("path");

const DEFAULT_CONFIG = {
  apiKey: "",
  endpoint: "https://openrouter.ai/api/v1/chat/completions",
  model: "deepseek/deepseek-chat",
  openRouterTitle: "Code Bubble Tutor",
  explanationLevel: "intermediate",
  hotkey: "CommandOrControl+Shift+Space",
  useAccessibilityFirst: true
};

function normalizeConfig(input = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...input,
    apiKey: String(input.apiKey ?? DEFAULT_CONFIG.apiKey),
    endpoint: String(input.endpoint ?? DEFAULT_CONFIG.endpoint),
    model: String(input.model ?? DEFAULT_CONFIG.model),
    openRouterTitle: String(input.openRouterTitle ?? DEFAULT_CONFIG.openRouterTitle),
    explanationLevel: ["beginner", "intermediate", "advanced"].includes(input.explanationLevel)
      ? input.explanationLevel
      : DEFAULT_CONFIG.explanationLevel,
    hotkey: String(input.hotkey ?? DEFAULT_CONFIG.hotkey),
    useAccessibilityFirst:
      typeof input.useAccessibilityFirst === "boolean"
        ? input.useAccessibilityFirst
        : DEFAULT_CONFIG.useAccessibilityFirst
  };
}

function getConfigPath(electronApp) {
  return path.join(electronApp.getPath("userData"), "config.json");
}

async function ensureConfig(electronApp) {
  const configPath = getConfigPath(electronApp);
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  try {
    const existing = JSON.parse(await fs.readFile(configPath, "utf8"));
    const merged = normalizeConfig(existing);
    await fs.writeFile(configPath, JSON.stringify(merged, null, 2));
    return merged;
  } catch {
    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
}

async function readConfig(electronApp) {
  return ensureConfig(electronApp);
}

async function saveConfig(electronApp, partialConfig) {
  const configPath = getConfigPath(electronApp);
  const current = await ensureConfig(electronApp);
  const merged = normalizeConfig({ ...current, ...partialConfig });
  await fs.writeFile(configPath, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  DEFAULT_CONFIG,
  ensureConfig,
  readConfig,
  saveConfig,
  normalizeConfig,
  getConfigPath
};

