async function loadState() {
  const state = await window.assistant.getState();
  document.getElementById("hotkeyValue").textContent = state.hotkeyRegistered;
  document.getElementById("modelValue").textContent = state.config.model;
  document.getElementById("levelValue").textContent = state.config.explanationLevel;
  document.getElementById("configPathValue").textContent = state.configPath;

  document.getElementById("apiKeyInput").value = state.config.apiKey || "";
  document.getElementById("endpointInput").value = state.config.endpoint || "";
  document.getElementById("modelInput").value = state.config.model || "";
  document.getElementById("titleInput").value = state.config.openRouterTitle || "";
  document.getElementById("levelInput").value = state.config.explanationLevel || "intermediate";
  document.getElementById("hotkeyInput").value = state.config.hotkey || "";
  document.getElementById("uiaToggle").checked = Boolean(state.config.useAccessibilityFirst);
}

document.getElementById("startBtn").addEventListener("click", async () => {
  await window.assistant.startSelection();
  document.getElementById("statusText").textContent = "Overlay active. Drag over code anywhere on screen.";
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const payload = {
    apiKey: document.getElementById("apiKeyInput").value,
    endpoint: document.getElementById("endpointInput").value,
    model: document.getElementById("modelInput").value,
    openRouterTitle: document.getElementById("titleInput").value,
    explanationLevel: document.getElementById("levelInput").value,
    hotkey: document.getElementById("hotkeyInput").value,
    useAccessibilityFirst: document.getElementById("uiaToggle").checked
  };

  await window.assistant.saveConfig(payload);
  await loadState();
  document.getElementById("statusText").textContent = "Settings saved and hotkey re-registered.";
});

document.getElementById("configBtn").addEventListener("click", async () => {
  await window.assistant.openConfig();
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  await window.assistant.refreshConfig();
  await loadState();
  document.getElementById("statusText").textContent = "Configuration reloaded.";
});

loadState();
