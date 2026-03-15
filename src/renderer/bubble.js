const titleEl = document.getElementById("bubbleTitle");
const loadingEl = document.getElementById("bubbleLoading");
const modeEl = document.getElementById("bubbleMode");
const selectedCodeEl = document.getElementById("bubbleSelectedCode");
const selectedCodeMetaEl = document.getElementById("bubbleSelectedCodeMeta");
const selectedCodeToggleEl = document.getElementById("bubbleSelectedCodeToggle");
const codeWindowEl = document.getElementById("bubbleCodeWindow");
const summaryEl = document.getElementById("bubbleSummary");
const contextPanelEl = document.getElementById("bubbleContextPanel");
const contextVerdictEl = document.getElementById("bubbleContextVerdict");
const contextListEl = document.getElementById("bubbleContextList");
const notesEl = document.getElementById("bubbleNotes");
const termsEl = document.getElementById("bubbleTerms");
const termsSectionEl = document.getElementById("bubbleTermsSection");
const bubbleScroll = document.getElementById("bubbleScroll");
const bubbleRoot = document.getElementById("bubbleRoot");
const resizeHandleEl = document.getElementById("bubbleResizeHandle");
const ingestBtnEl = document.getElementById("bubbleIngestBtn");
const clearChainBtnEl = document.getElementById("bubbleClearChainBtn");
const chainStatusEl = document.getElementById("bubbleChainStatus");
const contextToggleEl = document.getElementById("bubbleContextToggle");
const statusEl = document.getElementById("bubbleStatus");
const branchRowEl = document.getElementById("bubbleBranchRow");
const branchStatusEl = document.getElementById("bubbleBranchStatus");
const branchBackBtnEl = document.getElementById("bubbleBranchBackBtn");

let canDismiss = false;
let isDecoupled = false;
let bubbleRadius = 30;
let dragState = null;
let resizeState = null;
let shiftHeld = false;
let geometrySyncQueued = false;
let chainCount = 0;
let chainPreview = [];
let selectedCodeExpanded = false;
let contextPanelOpen = false;
let currentContextVerdict = "";
let statusTimer = null;
let branchActive = false;
let lastRegularExplanation = null;

function cloneRegularExplanation(explanation) {
  if (!explanation || typeof explanation !== "object") {
    return null;
  }
  return {
    source: explanation.source,
    captureSource: explanation.captureSource,
    extractedText: explanation.extractedText,
    headline: explanation.headline,
    summary: explanation.summary,
    notes: Array.isArray(explanation.notes) ? [...explanation.notes] : [],
    terms: Array.isArray(explanation.terms) ? [...explanation.terms] : [],
    memoryChainCount: explanation.memoryChainCount,
    memoryPreview: Array.isArray(explanation.memoryPreview) ? [...explanation.memoryPreview] : []
  };
}

function isInteractiveTarget(target) {
  if (!target || typeof target.closest !== "function") {
    return false;
  }
  return Boolean(target.closest("button, a, input, textarea, select, label"));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setChainStatus() {
  if (!chainStatusEl) {
    return;
  }
  chainStatusEl.textContent = `Context: ${chainCount}`;
}

function renderContextList() {
  if (!contextListEl) {
    return;
  }
  contextListEl.innerHTML = "";
  if (!chainPreview.length) {
    const li = document.createElement("li");
    li.textContent = "No ingested items yet.";
    contextListEl.appendChild(li);
    return;
  }
  chainPreview.forEach((item, index) => {
    const li = document.createElement("li");
    li.textContent = `${index + 1}. ${item}`;
    contextListEl.appendChild(li);
  });
}

function setContextPanelOpen(open) {
  contextPanelOpen = Boolean(open);
  if (contextPanelEl) {
    contextPanelEl.hidden = !contextPanelOpen;
  }
  if (contextToggleEl) {
    contextToggleEl.textContent = contextPanelOpen ? "Hide context" : "Show context";
  }
  if (contextVerdictEl) {
    contextVerdictEl.textContent = currentContextVerdict || "No context verdict available yet.";
  }
  renderContextList();
}

function setTransientStatus(text, kind = "info", timeoutMs = 2200) {
  if (!statusEl) {
    return;
  }

  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }

  if (!text) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.classList.remove("error", "success");
    return;
  }

  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle("error", kind === "error");
  statusEl.classList.toggle("success", kind === "success");

  if (timeoutMs > 0) {
    statusTimer = setTimeout(() => {
      setTransientStatus("");
    }, timeoutMs);
  }
}

function setBranchStatus(text) {
  if (!branchRowEl || !branchStatusEl) {
    return;
  }
  if (!branchActive || !text) {
    branchRowEl.hidden = true;
    branchStatusEl.textContent = "";
    return;
  }
  branchRowEl.hidden = false;
  branchStatusEl.textContent = text;
}

function setSelectedCodePanel(text) {
  const content = String(text || "");
  const lines = content.split(/\r?\n/);
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0).length;
  const charCount = content.length;

  selectedCodeEl.textContent = content || "(No snippet text available)";
  if (selectedCodeMetaEl) {
    selectedCodeMetaEl.textContent = `${nonEmptyLines} line(s) | ${charCount} chars`;
  }

  selectedCodeExpanded = false;
  if (selectedCodeToggleEl) {
    selectedCodeToggleEl.textContent = "Show code";
  }
  if (codeWindowEl) {
    codeWindowEl.classList.remove("expanded");
  }
}

function renderExplanation(explanation) {
  notesEl.innerHTML = "";
  termsEl.innerHTML = "";

  setSelectedCodePanel(explanation.extractedText || "");

  if (explanation.source === "status") {
    titleEl.textContent = explanation.headline || "Working";
  } else {
    const captureSource = explanation.captureSource
      ? ` via ${explanation.captureSource}`
      : "";
    titleEl.textContent = explanation.headline || `Source: ${explanation.source}${captureSource}`;
  }
  summaryEl.textContent = explanation.summary || explanation.extractedText || "";

  let contextVerdict = "";
  (explanation.notes || []).forEach((note) => {
    if (/^Context verdict:/i.test(note)) {
      contextVerdict = note;
      return;
    }
    const li = document.createElement("li");
    li.textContent = note;
    notesEl.appendChild(li);
  });

  currentContextVerdict = contextVerdict || "";
  if (contextPanelOpen) {
    setContextPanelOpen(true);
  }

  if (Array.isArray(explanation.terms) && explanation.terms.length > 0) {
    termsSectionEl.style.display = "block";
    explanation.terms.forEach((term) => {
      const chip = document.createElement("button");
      chip.className = "term-chip";
      chip.textContent = term;
      chip.setAttribute("type", "button");
      chip.setAttribute("data-term", term);
      chip.title = `Branch on ${term}`;
      termsEl.appendChild(chip);
    });
  } else {
    termsSectionEl.style.display = "none";
  }
}

function syncGeometryToMain() {
  if (geometrySyncQueued) {
    return;
  }
  geometrySyncQueued = true;

  requestAnimationFrame(async () => {
    geometrySyncQueued = false;
    const rect = bubbleRoot.getBoundingClientRect();
    try {
      await window.assistant.updateBubbleGeometry({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        radius: bubbleRadius
      });
    } catch {
      // Ignore transient IPC errors while window is changing state.
    }
  });
}

async function refreshChainState() {
  try {
    const state = await window.assistant.getIngestState();
    if (state?.ok) {
      chainCount = Number(state.count) || 0;
      chainPreview = Array.isArray(state.preview) ? state.preview.slice(-3) : [];
      setChainStatus();
    }
  } catch {
    // Ignore intermittent IPC errors.
  }
}

function setModeText() {
  modeEl.textContent = isDecoupled
    ? "Decoupled: drag, resize, Alt+wheel changes shape"
    : "Coupled to cursor";
}

async function setCoupledState(coupled) {
  if (isDecoupled === !coupled) {
    return;
  }

  isDecoupled = !coupled;
  document.body.classList.toggle("decoupled", isDecoupled);
  setModeText();
  try {
    await window.assistant.setCoupled(coupled);
  } catch {
    // Keep UI responsive even if IPC briefly fails.
  }
  if (!coupled) {
    syncGeometryToMain();
  }
}

document.addEventListener("mousedown", async (event) => {
  if (isDecoupled) {
    return;
  }
  if (event.button !== 0 || !canDismiss) {
    return;
  }
  if (isInteractiveTarget(event.target)) {
    return;
  }
  await window.assistant.hideBubble();
});

document.addEventListener("dblclick", async (event) => {
  if (isDecoupled || event.button !== 0) {
    return;
  }
  if (isInteractiveTarget(event.target)) {
    return;
  }
  await window.assistant.hideBubble();
});

document.addEventListener(
  "wheel",
  async (event) => {
    if (isDecoupled && event.altKey) {
      bubbleRadius = clamp(bubbleRadius + (event.deltaY > 0 ? -1 : 1), 8, 44);
      bubbleRoot.style.setProperty("--bubble-radius", `${bubbleRadius}px`);
      await syncGeometryToMain();
      event.preventDefault();
      return;
    }

    bubbleScroll.scrollTop += event.deltaY;
    event.preventDefault();
  },
  { passive: false }
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Shift") {
    shiftHeld = true;
  }
  if (event.key === "Shift" && canDismiss && !isDecoupled) {
    setCoupledState(false);
  }
});

document.addEventListener("keyup", (event) => {
  if (event.key === "Shift") {
    shiftHeld = false;
  }
  if (event.key === "Shift" && isDecoupled) {
    setCoupledState(true);
  }
});

window.addEventListener("blur", () => {
  shiftHeld = false;
  if (isDecoupled) {
    setCoupledState(true);
  }
});

bubbleRoot.addEventListener("pointerdown", (event) => {
  if (!isDecoupled && canDismiss && event.shiftKey) {
    shiftHeld = true;
    setCoupledState(false);
  }

  if (!isDecoupled || event.button !== 0) {
    return;
  }
  if (isInteractiveTarget(event.target)) {
    return;
  }
  if (event.target === resizeHandleEl) {
    return;
  }

  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startLeft: bubbleRoot.offsetLeft,
    startTop: bubbleRoot.offsetTop
  };
  bubbleRoot.setPointerCapture(event.pointerId);
});

resizeHandleEl.addEventListener("pointerdown", (event) => {
  if (!isDecoupled && canDismiss) {
    shiftHeld = Boolean(event.shiftKey);
    setCoupledState(false);
  }

  if (!isDecoupled || event.button !== 0) {
    return;
  }

  resizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: bubbleRoot.offsetWidth,
    startHeight: bubbleRoot.offsetHeight
  };
  resizeHandleEl.setPointerCapture(event.pointerId);
  event.stopPropagation();
});

document.addEventListener("pointermove", (event) => {
  if (!isDecoupled && canDismiss && event.shiftKey) {
    shiftHeld = true;
    setCoupledState(false);
  }

  if (dragState && event.pointerId === dragState.pointerId) {
    const maxLeft = window.innerWidth - bubbleRoot.offsetWidth;
    const maxTop = window.innerHeight - bubbleRoot.offsetHeight;
    const nextLeft = clamp(dragState.startLeft + (event.clientX - dragState.startX), 0, maxLeft);
    const nextTop = clamp(dragState.startTop + (event.clientY - dragState.startY), 0, maxTop);
    bubbleRoot.style.left = `${nextLeft}px`;
    bubbleRoot.style.top = `${nextTop}px`;
    syncGeometryToMain();
  }

  if (resizeState && event.pointerId === resizeState.pointerId) {
    const nextWidth = clamp(resizeState.startWidth + (event.clientX - resizeState.startX), 320, 980);
    const nextHeight = clamp(resizeState.startHeight + (event.clientY - resizeState.startY), 220, 760);
    bubbleRoot.style.width = `${nextWidth}px`;
    bubbleRoot.style.height = `${nextHeight}px`;
    syncGeometryToMain();
  }
});

document.addEventListener("pointerup", (event) => {
  if (dragState && event.pointerId === dragState.pointerId) {
    dragState = null;
    syncGeometryToMain();
  }
  if (resizeState && event.pointerId === resizeState.pointerId) {
    resizeState = null;
    syncGeometryToMain();
  }
});

if (ingestBtnEl) {
  ingestBtnEl.addEventListener("click", async () => {
    setTransientStatus("Ingesting selection into context chain...", "info", 1800);
    try {
      let result = await window.assistant.ingestLatestSelection();
      if (!result?.ok) {
        result = await window.assistant.ingestCurrentSelection();
      }
      if (!result?.ok) {
        setTransientStatus(result?.error || "Unable to ingest selection.", "error", 3000);
        return;
      }
      chainCount = Number(result.count) || 0;
      chainPreview = Array.isArray(result.preview) ? result.preview.slice(-3) : [];
      setChainStatus();
      setTransientStatus("Selection added to chain.", "success", 1800);
    } catch {
      setTransientStatus("Unable to ingest selection.", "error", 3000);
    }
  });
}

if (clearChainBtnEl) {
  clearChainBtnEl.addEventListener("click", async () => {
    try {
      const result = await window.assistant.clearIngestChain();
      if (result?.ok) {
        chainCount = 0;
        chainPreview = [];
        setChainStatus();
        setTransientStatus("Context chain cleared.", "success", 1800);
      }
    } catch {
      setTransientStatus("Unable to clear context chain.", "error", 3000);
    }
  });
}

if (selectedCodeToggleEl) {
  selectedCodeToggleEl.addEventListener("click", () => {
    selectedCodeExpanded = !selectedCodeExpanded;
    codeWindowEl.classList.toggle("expanded", selectedCodeExpanded);
    selectedCodeToggleEl.textContent = selectedCodeExpanded ? "Hide code" : "Show code";
  });
}

if (contextToggleEl) {
  contextToggleEl.addEventListener("click", () => {
    setContextPanelOpen(!contextPanelOpen);
  });
}

if (branchBackBtnEl) {
  branchBackBtnEl.addEventListener("click", () => {
    if (!lastRegularExplanation) {
      return;
    }
    branchActive = false;
    setBranchStatus("");
    renderExplanation(lastRegularExplanation);
    setTransientStatus("Returned to snippet explanation.", "success", 1600);
  });
}

termsEl.addEventListener("click", async (event) => {
  const target = event.target.closest(".term-chip");
  if (!target) {
    return;
  }

  const term = target.getAttribute("data-term") || target.textContent || "";
  if (!term.trim()) {
    return;
  }

  setTransientStatus("Building branch explanation...", "info", 1400);
  try {
    const result = await window.assistant.explainBranch(term.trim());
    if (!result?.ok) {
      setTransientStatus(result?.error || "Unable to build branch explanation.", "error", 3200);
    }
  } catch {
    setTransientStatus("Unable to build branch explanation.", "error", 3200);
  }
});

window.assistant.onBubblePosition((payload) => {
  if (typeof payload.coupled === "boolean") {
    const nextDecoupled = !payload.coupled;
    if (nextDecoupled !== isDecoupled) {
      isDecoupled = nextDecoupled;
      document.body.classList.toggle("decoupled", isDecoupled);
      setModeText();
    }
  }

  if (isDecoupled) {
    return;
  }
  bubbleRoot.style.left = `${payload.x}px`;
  bubbleRoot.style.top = `${payload.y}px`;
  bubbleRoot.style.width = `${payload.width}px`;
  bubbleRoot.style.height = `${payload.height}px`;
  bubbleRadius = Number.isFinite(payload.radius) ? payload.radius : bubbleRadius;
  bubbleRoot.style.setProperty("--bubble-radius", `${bubbleRadius}px`);
});

window.assistant.onBubbleUpdate((payload) => {
  bubbleScroll.scrollTop = 0;

  const isLoading = Boolean(payload.loading);
  canDismiss = payload.ok && !isLoading && payload.explanation?.source !== "status";
  bubbleRoot.classList.toggle("editable", canDismiss);
  if (!canDismiss && isDecoupled) {
    setCoupledState(true);
  }

  loadingEl.hidden = !isLoading;
  loadingEl.style.display = isLoading ? "flex" : "none";
  bubbleScroll.style.opacity = isLoading ? "0.55" : "1";

  if (!payload.ok) {
    titleEl.textContent = "Unable to explain selection";
    setSelectedCodePanel(payload.explanation?.extractedText || "");
    summaryEl.textContent = payload.error || "Unknown error.";
    currentContextVerdict = "";
    setContextPanelOpen(false);
    termsSectionEl.style.display = "none";
    branchActive = false;
    setBranchStatus("");
    setTransientStatus("");
    return;
  }

  const explanation = payload.explanation || {};

  chainCount = Number(explanation.memoryChainCount) || chainCount;
  chainPreview = Array.isArray(explanation.memoryPreview) ? explanation.memoryPreview.slice(-3) : chainPreview;
  setChainStatus();
  renderContextList();

  if (explanation.branchFromTerm) {
    branchActive = true;
    setBranchStatus(`Branch view: ${explanation.branchFromTerm}`);
  } else {
    branchActive = false;
    setBranchStatus("");
    if (explanation.source !== "status") {
      lastRegularExplanation = cloneRegularExplanation(explanation);
    }
  }

  renderExplanation(explanation);

  if (explanation.source === "status" || isLoading) {
    termsSectionEl.style.display = "none";
  }

  if (isLoading) {
    currentContextVerdict = "";
    setContextPanelOpen(false);
    setTransientStatus("");
  }
});

setModeText();
setChainStatus();
setContextPanelOpen(false);
setBranchStatus("");
setTransientStatus("");
refreshChainState();
