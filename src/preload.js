const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistant", {
  getState: () => ipcRenderer.invoke("assistant:get-state"),
  startSelection: () => ipcRenderer.invoke("assistant:start-selection"),
  hideBubble: () => ipcRenderer.invoke("assistant:hide-bubble"),
  setCoupled: (coupled) => ipcRenderer.invoke("assistant:set-coupled", coupled),
  updateBubbleGeometry: (geometry) => ipcRenderer.invoke("assistant:update-bubble-geometry", geometry),
  getIngestState: () => ipcRenderer.invoke("assistant:get-ingest-state"),
  ingestCurrentSelection: () => ipcRenderer.invoke("assistant:ingest-current-selection"),
  ingestLatestSelection: () => ipcRenderer.invoke("assistant:ingest-latest-selection"),
  clearIngestChain: () => ipcRenderer.invoke("assistant:clear-ingest-chain"),
  explainBranch: (term) => ipcRenderer.invoke("assistant:explain-branch", term),
  openConfig: () => ipcRenderer.invoke("assistant:open-config"),
  refreshConfig: () => ipcRenderer.invoke("assistant:refresh-config"),
  saveConfig: (config) => ipcRenderer.invoke("assistant:save-config", config),
  processSelection: (payload) => ipcRenderer.invoke("assistant:process-selection", payload),
  onBubbleUpdate: (handler) => {
    ipcRenderer.removeAllListeners("assistant:bubble-update");
    ipcRenderer.on("assistant:bubble-update", (_event, payload) => handler(payload));
  },
  onBubblePosition: (handler) => {
    ipcRenderer.removeAllListeners("assistant:bubble-position");
    ipcRenderer.on("assistant:bubble-position", (_event, payload) => handler(payload));
  }
});
