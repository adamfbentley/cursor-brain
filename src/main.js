const path = require("path");
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray
} = require("electron");

const { ensureConfig, readConfig, saveConfig, getConfigPath } = require("./services/config");
const {
  explainCapturedRegion,
  captureSelectedTextIfAvailable,
  explainSelectionWithContext,
  explainDrilldownWithContext
} = require("./services/explainer");
const { isLeftMouseButtonDown } = require("./services/windows-accessibility");

let settingsWindow;
let overlayWindow;
let bubbleWindow;
let tray;
let currentHotkey;
let armTimer;
let pollTimer;
let bubbleFollowTimer;
let pollInFlight = false;
let armActive = false;
let lastSelectionDigest = "";
let bubbleReady = false;
let bubbleVisible = false;
let bubbleInteractive = false;
let isQuitting = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

const ARM_WINDOW_MS = 20000;
const ARM_POLL_MS = 260;
const BUBBLE_WIDTH = 420;
const BUBBLE_HEIGHT = 300;
const BUBBLE_OFFSET = 42;
const BUBBLE_FOLLOW_MS = 16;
const BUBBLE_MIN_WIDTH = 320;
const BUBBLE_MIN_HEIGHT = 220;
const BUBBLE_MAX_WIDTH = 980;
const BUBBLE_MAX_HEIGHT = 760;

let bubbleWidth = BUBBLE_WIDTH;
let bubbleHeight = BUBBLE_HEIGHT;
let bubbleRadius = 30;
let bubbleOffsetX = BUBBLE_OFFSET;
let bubbleOffsetY = BUBBLE_OFFSET;
let bubbleRecoupleAnchorOffsetX = BUBBLE_OFFSET;
let bubbleRecoupleAnchorOffsetY = BUBBLE_OFFSET;
let bubbleCoupled = true;
let bubblePosition = null;
let latestSelectionText = "";
let latestSelectionSource = "";
let ingestChain = [];
const MAX_INGEST_CHAIN = 10;

function buildRendererPath(fileName) {
  return path.join(__dirname, "renderer", fileName);
}

function digestSelection(text) {
  return String(text || "").trim().slice(0, 280);
}

function buildSelectionLabel(text) {
  const first = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) {
    return "Selection";
  }
  return first.length > 48 ? `${first.slice(0, 45)}...` : first;
}

function estimateSelectionScale(text) {
  const normalized = String(text || "");
  const nonEmptyLines = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const charCount = normalized.length;
  if (charCount > 6000 || nonEmptyLines > 120) {
    return "file";
  }
  if (charCount > 1200 || nonEmptyLines > 18) {
    return "block";
  }
  return "snippet";
}

function getIngestContext() {
  const latestWholeFile = [...ingestChain].reverse().find((item) => item.selectionScale === "file");
  const source = latestWholeFile ? [latestWholeFile] : ingestChain;
  return source.map((item) => ({
    text: item.text,
    source: item.source,
    label: item.label,
    selectionScale: item.selectionScale || "snippet"
  }));
}

function attachContextMeta(explanation, extra = {}) {
  return {
    ...explanation,
    memoryChainCount: ingestChain.length,
    memoryPreview: ingestChain.slice(-3).map((item) => item.label),
    ...extra
  };
}

function getVirtualScreenBounds() {
  const displays = screen.getAllDisplays();
  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function computeBubbleTargetBounds(cursor) {
  const display = screen.getDisplayNearestPoint({ x: cursor.x, y: cursor.y });
  const workArea = display.workArea;

  let posX = cursor.x + bubbleOffsetX;
  let posY = cursor.y + bubbleOffsetY;

  if (posX + bubbleWidth > workArea.x + workArea.width) {
    posX = workArea.x + workArea.width - bubbleWidth;
  }
  if (posY + bubbleHeight > workArea.y + workArea.height) {
    posY = workArea.y + workArea.height - bubbleHeight;
  }

  return {
    x: Math.max(workArea.x, posX),
    y: Math.max(workArea.y, posY),
    width: bubbleWidth,
    height: bubbleHeight
  };
}

function stopBubbleFollow() {
  if (bubbleFollowTimer) {
    clearInterval(bubbleFollowTimer);
    bubbleFollowTimer = null;
  }
}

function sendBubblePosition(cursor) {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    return;
  }

  const point = cursor || screen.getCursorScreenPoint();
  if (!bubblePosition || bubbleCoupled) {
    const target = computeBubbleTargetBounds(point);
    bubblePosition = { x: target.x, y: target.y };
  }

  const virtualBounds = getVirtualScreenBounds();
  bubbleWindow.webContents.send("assistant:bubble-position", {
    x: bubblePosition.x - virtualBounds.x,
    y: bubblePosition.y - virtualBounds.y,
    width: bubbleWidth,
    height: bubbleHeight,
    radius: bubbleRadius,
    coupled: bubbleCoupled
  });
}

function setBubbleInteractivity(interactive) {
  bubbleInteractive = Boolean(interactive);
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    return;
  }

  bubbleWindow.setIgnoreMouseEvents(!bubbleInteractive, { forward: true });
  if (bubbleInteractive) {
    bubbleWindow.focus();
  }
}

function startBubbleFollow() {
  stopBubbleFollow();
  bubbleFollowTimer = setInterval(() => {
    if (!bubbleVisible || !bubbleWindow || bubbleWindow.isDestroyed()) {
      stopBubbleFollow();
      return;
    }

    if (!bubbleCoupled) {
      return;
    }

    sendBubblePosition(screen.getCursorScreenPoint());
  }, BUBBLE_FOLLOW_MS);
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="8" y="10" width="48" height="36" rx="14" fill="#0f172a" stroke="#38bdf8" stroke-width="4"/>
      <path d="M18 46 L28 46 L22 56 Z" fill="#0f172a" stroke="#38bdf8" stroke-width="4" stroke-linejoin="round"/>
      <circle cx="24" cy="28" r="3" fill="#7dd3fc"/>
      <circle cx="32" cy="28" r="3" fill="#7dd3fc"/>
      <circle cx="40" cy="28" r="3" fill="#7dd3fc"/>
    </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const menu = Menu.buildFromTemplate([
    {
      label: "Start Selection Overlay",
      click: () => {
        createOverlayWindow();
      }
    },
    {
      label: "Show Settings",
      click: () => {
        showSettingsWindow();
      }
    },
    {
      label: "Open Config File",
      click: () => {
        shell.openPath(getConfigPath(app));
      }
    },
    { type: "separator" },
    {
      label: `Hotkey: ${currentHotkey || "Unregistered"}`,
      enabled: false
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("Code Bubble Tutor");
  tray.on("double-click", () => {
    showSettingsWindow();
  });
  updateTrayMenu();
  return tray;
}

function showSettingsWindow() {
  const window = createSettingsWindow();
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  return window;
}

function createSettingsWindow() {
  if (settingsWindow) {
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 620,
    minHeight: 700,
    title: "Code Bubble Tutor Settings",
    autoHideMenuBar: true,
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  settingsWindow.loadFile(buildRendererPath("control.html"));
  settingsWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      settingsWindow.hide();
    }
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

function createOverlayWindow() {
  if (overlayWindow) {
    overlayWindow.focus();
    return overlayWindow;
  }

  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    backgroundColor: "#00000000",
    title: "Selection Overlay",
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  overlayWindow.loadFile(buildRendererPath("overlay.html"));
  overlayWindow.on("closed", () => {
    overlayWindow = null;
  });
  overlayWindow.focus();

  return overlayWindow;
}

function ensureBubbleWindow() {
  if (bubbleWindow) {
    return bubbleWindow;
  }

  bubbleReady = false;
  const bounds = getVirtualScreenBounds();
  bubbleWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    transparent: true,
    title: "Explanation Bubble",
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  bubbleWindow.loadFile(buildRendererPath("bubble.html"));
  bubbleWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubbleWindow.webContents.on("did-finish-load", () => {
    bubbleReady = true;
  });
  bubbleWindow.on("closed", () => {
    stopBubbleFollow();
    bubbleWindow = null;
    bubbleReady = false;
    bubbleVisible = false;
  });

  return bubbleWindow;
}

function hideBubble() {
  bubbleVisible = false;
  bubbleInteractive = false;
  bubbleCoupled = true;
  stopBubbleFollow();
  if (bubbleWindow && !bubbleWindow.isDestroyed()) {
    bubbleWindow.setIgnoreMouseEvents(true, { forward: true });
    bubbleWindow.hide();
  }
}

async function showBubble(cursor, payload) {
  const bubble = ensureBubbleWindow();
  const bounds = getVirtualScreenBounds();
  bubble.setBounds(bounds);

  const sendPayload = () => {
    bubble.webContents.send("assistant:bubble-update", payload);
    sendBubblePosition(cursor);
    const shouldInteract = Boolean(
      payload &&
      payload.ok &&
      !payload.loading &&
      payload.explanation &&
      payload.explanation.source !== "status"
    );
    setBubbleInteractivity(shouldInteract);
    bubbleVisible = true;
    if (shouldInteract) {
      bubble.show();
    } else {
      bubble.showInactive();
    }
    startBubbleFollow();
  };

  if (bubbleReady) {
    sendPayload();
  } else {
    bubble.webContents.once("did-finish-load", sendPayload);
  }
}

async function showStatusBubble(message, loading = true) {
  const cursor = screen.getCursorScreenPoint();
  await showBubble(cursor, {
    ok: true,
    loading,
    explanation: {
      source: "status",
      captureSource: "assistant",
      headline: loading ? "Waiting for selection" : "Code Bubble Tutor",
      summary: message,
      notes: []
    }
  });
}

async function showLoadingBubble() {
  const cursor = screen.getCursorScreenPoint();
  await showBubble(cursor, {
    ok: true,
    loading: true,
    explanation: {
      source: "status",
      captureSource: "assistant",
      headline: "Reading your selection...",
      summary: "Analyzing the highlighted code and preparing a teaching explanation.",
      notes: [],
      terms: []
    }
  });
}

function disarmSelectionMode(notify = false) {
  armActive = false;
  pollInFlight = false;
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (notify) {
    showStatusBubble("Selection wait timed out. Select code, then press the hotkey again.", false);
  }
}

async function tryCaptureThenExplain() {
  if (pollInFlight) {
    return false;
  }

  pollInFlight = true;
  try {
    // Wait until selection gesture is complete so we capture the final highlight.
    if (await isLeftMouseButtonDown()) {
      return false;
    }

    const selected = await captureSelectedTextIfAvailable(app);
    if (!selected || !selected.text) {
      return false;
    }

    const digest = digestSelection(selected.text);
    if (!digest || digest === lastSelectionDigest) {
      return false;
    }

    // A concrete selection was captured: stop waiting timers immediately.
    if (armActive) {
      disarmSelectionMode(false);
    }

    lastSelectionDigest = digest;
    latestSelectionText = selected.text;
    latestSelectionSource = selected.source || "uia";

    // Switch to explicit loading state while generating explanation.
    await showLoadingBubble();

    const explanation = await explainSelectionWithContext(
      app,
      selected.text,
      latestSelectionSource,
      {
        selectionScale: estimateSelectionScale(selected.text),
        contextSelections: getIngestContext()
      }
    );
    if (!explanation) {
      return false;
    }

    const cursor = screen.getCursorScreenPoint();
    await showBubble(cursor, {
      ok: true,
      loading: false,
      explanation: attachContextMeta(explanation)
    });
    return true;
  } catch {
    return false;
  } finally {
    pollInFlight = false;
  }
}

function armSelectionMode() {
  if (armActive) {
    disarmSelectionMode(false);
  }

  // Reset session-level digest gate for each new hotkey-triggered capture cycle.
  lastSelectionDigest = "";
  armActive = true;
  showStatusBubble("Select code now. Bubble stays open while waiting.", true);

  pollTimer = setInterval(() => {
    tryCaptureThenExplain();
  }, ARM_POLL_MS);

  armTimer = setTimeout(() => {
    disarmSelectionMode(true);
  }, ARM_WINDOW_MS);
}

async function triggerAssistantFromHotkey() {
  // Per requested behavior: show awaiting state first, then load only when selection triggers.
  armSelectionMode();
}

function registerHotkey(hotkey) {
  globalShortcut.unregisterAll();
  currentHotkey = hotkey;
  const registered = globalShortcut.register(hotkey, () => {
    triggerAssistantFromHotkey();
  });
  updateTrayMenu();
  return registered;
}

async function getState() {
  const config = await readConfig(app);
  return {
    configPath: getConfigPath(app),
    config,
    hotkeyRegistered: currentHotkey || config.hotkey
  };
}

app.whenReady().then(async () => {
  const config = await ensureConfig(app);
  registerHotkey(config.hotkey);
  createTray();
  showSettingsWindow();
});

app.on("second-instance", () => {
  showSettingsWindow();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  showSettingsWindow();
});

ipcMain.handle("assistant:get-state", async () => {
  return getState();
});

ipcMain.handle("assistant:start-selection", () => {
  createOverlayWindow();
  return { ok: true };
});

ipcMain.handle("assistant:open-config", async () => {
  await shell.openPath(getConfigPath(app));
  return { ok: true };
});

ipcMain.handle("assistant:refresh-config", async () => {
  const config = await ensureConfig(app);
  registerHotkey(config.hotkey);
  return getState();
});

ipcMain.handle("assistant:save-config", async (_event, partialConfig) => {
  const config = await saveConfig(app, partialConfig);
  registerHotkey(config.hotkey);
  return getState();
});

ipcMain.handle("assistant:hide-bubble", () => {
  hideBubble();
  return { ok: true };
});

ipcMain.handle("assistant:set-coupled", (_event, coupled) => {
  bubbleCoupled = Boolean(coupled);

  if (!bubbleVisible) {
    return { ok: true, coupled: bubbleCoupled };
  }

  if (bubbleCoupled) {
    const cursor = screen.getCursorScreenPoint();
    bubbleOffsetX = bubbleRecoupleAnchorOffsetX;
    bubbleOffsetY = bubbleRecoupleAnchorOffsetY;
    startBubbleFollow();
    sendBubblePosition(cursor);
  } else {
    const cursor = screen.getCursorScreenPoint();
    if (bubblePosition) {
      bubbleRecoupleAnchorOffsetX = bubblePosition.x - cursor.x;
      bubbleRecoupleAnchorOffsetY = bubblePosition.y - cursor.y;
    } else {
      bubbleRecoupleAnchorOffsetX = bubbleOffsetX;
      bubbleRecoupleAnchorOffsetY = bubbleOffsetY;
    }
    setBubbleInteractivity(true);
    stopBubbleFollow();
  }

  return { ok: true, coupled: bubbleCoupled };
});

ipcMain.handle("assistant:update-bubble-geometry", (_event, geometry) => {
  if (!geometry || typeof geometry !== "object") {
    return { ok: false };
  }

  if (Number.isFinite(geometry.width)) {
    bubbleWidth = Math.max(BUBBLE_MIN_WIDTH, Math.min(BUBBLE_MAX_WIDTH, Math.round(geometry.width)));
  }
  if (Number.isFinite(geometry.height)) {
    bubbleHeight = Math.max(BUBBLE_MIN_HEIGHT, Math.min(BUBBLE_MAX_HEIGHT, Math.round(geometry.height)));
  }
  if (Number.isFinite(geometry.radius)) {
    bubbleRadius = Math.max(8, Math.min(44, Math.round(geometry.radius)));
  }
  if (Number.isFinite(geometry.x) && Number.isFinite(geometry.y)) {
    bubblePosition = { x: Math.round(geometry.x), y: Math.round(geometry.y) };
  }

  if (bubbleVisible) {
    sendBubblePosition(screen.getCursorScreenPoint());
  }

  return {
    ok: true,
    width: bubbleWidth,
    height: bubbleHeight,
    radius: bubbleRadius,
    coupled: bubbleCoupled
  };
});

ipcMain.handle("assistant:process-selection", async (_event, payload) => {
  try {
    const explanation = await explainCapturedRegion(app, payload.bounds);
    latestSelectionText = explanation.extractedText || "";
    latestSelectionSource = explanation.captureSource || "screen-ocr";
    await showBubble(payload.cursor, {
      ok: true,
      loading: false,
      explanation: attachContextMeta(explanation)
    });
    if (overlayWindow) {
      overlayWindow.close();
    }
    return { ok: true };
  } catch (error) {
    await showBubble(payload.cursor, {
      ok: false,
      loading: false,
      error: error instanceof Error ? error.message : String(error)
    });
    if (overlayWindow) {
      overlayWindow.close();
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("assistant:get-ingest-state", () => {
  return {
    ok: true,
    count: ingestChain.length,
    preview: ingestChain.slice(-5).map((item) => item.label)
  };
});

ipcMain.handle("assistant:ingest-current-selection", async () => {
  const selected = (await captureSelectedTextIfAvailable(app)) || null;
  const text = selected?.text || latestSelectionText;
  if (!text) {
    return { ok: false, error: "No selection available to ingest." };
  }

  const digest = digestSelection(text);
  const existing = ingestChain.find((item) => item.digest === digest);
  if (!existing) {
    ingestChain.push({
      digest,
      text,
      source: selected?.source || latestSelectionSource || "bubble",
      label: buildSelectionLabel(text),
      selectionScale: estimateSelectionScale(text)
    });
    if (ingestChain.length > MAX_INGEST_CHAIN) {
      ingestChain = ingestChain.slice(-MAX_INGEST_CHAIN);
    }
  }

  return {
    ok: true,
    count: ingestChain.length,
    preview: ingestChain.slice(-5).map((item) => item.label)
  };
});

ipcMain.handle("assistant:clear-ingest-chain", () => {
  ingestChain = [];
  return { ok: true, count: 0, preview: [] };
});

ipcMain.handle("assistant:explain-branch", async (_event, term) => {
  if (!term || !String(term).trim()) {
    return { ok: false, error: "No branch term provided." };
  }

  const focusText = latestSelectionText;
  if (!focusText) {
    return { ok: false, error: "No active base selection to branch from." };
  }

  const explanation = await explainDrilldownWithContext(
    app,
    focusText,
    String(term).trim(),
    getIngestContext()
  );

  const cursor = screen.getCursorScreenPoint();
  await showBubble(cursor, {
    ok: true,
    loading: false,
    explanation: attachContextMeta(explanation, {
      branchFromTerm: String(term).trim()
    })
  });

  return { ok: true };
});

ipcMain.handle("assistant:ingest-latest-selection", () => {
  const text = latestSelectionText;
  if (!text) {
    return { ok: false, error: "No explained selection available to ingest yet." };
  }

  const digest = digestSelection(text);
  const existing = ingestChain.find((item) => item.digest === digest);
  if (!existing) {
    ingestChain.push({
      digest,
      text,
      source: latestSelectionSource || "bubble",
      label: buildSelectionLabel(text),
      selectionScale: estimateSelectionScale(text)
    });
    if (ingestChain.length > MAX_INGEST_CHAIN) {
      ingestChain = ingestChain.slice(-MAX_INGEST_CHAIN);
    }
  }

  return {
    ok: true,
    count: ingestChain.length,
    preview: ingestChain.slice(-5).map((item) => item.label)
  };
});