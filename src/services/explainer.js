const screenshot = require("screenshot-desktop");
const sharp = require("sharp");

const { readConfig } = require("./config");
const { extractTextFromImage } = require("./ocr");
const {
  captureSelectedTextViaAccessibility,
  captureSelectedTextViaClipboardProbe,
  isCtrlASelectionGestureActive
} = require("./windows-accessibility");

const OPENROUTER_TIMEOUT_MS = 18000;

function clampBounds(bounds) {
  const left = Math.max(0, Math.round(Math.min(bounds.x, bounds.x + bounds.width)));
  const top = Math.max(0, Math.round(Math.min(bounds.y, bounds.y + bounds.height)));
  const width = Math.max(32, Math.round(Math.abs(bounds.width)));
  const height = Math.max(24, Math.round(Math.abs(bounds.height)));
  return { left, top, width, height };
}

function determineSelectionScale(text) {
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

function fallbackExplanation(text, level, captureSource, options = {}) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const firstLine = lines[0] || text.trim() || "Selected code";
  const headline = firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
  const prefix = level === "beginner" ? "In simple terms" : level === "advanced" ? "Technically" : "Conceptually";
  const scale = options.selectionScale || determineSelectionScale(text);
  const lineNotes = scale === "file"
    ? buildFileLevelNotes(text)
    : buildHumanLogicNotes(text, scale);

  return {
    source: "local",
    captureSource,
    extractedText: text,
    headline,
    summary: `${prefix}, this selected code performs one focused job. ${buildGroundedSummary(text, scale)}`,
    notes: [
      "Read the snippet top-to-bottom and track what each line contributes.",
      ...lineNotes
    ],
    terms: extractIdentifierTerms(text)
  };
}

function buildLineNumberedSnippet(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "    "));

  const numbered = lines
    .filter((line) => line.trim().length > 0)
    .map((line, index) => `${index + 1}. ${line}`)
    .join("\n");

  return numbered || "1. (empty selection)";
}

function buildContextSnippet(chain) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return "";
  }

  const recent = chain.slice(-4);
  return recent
    .map((item, index) => {
      const cleaned = String(item?.text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(" ");
      return `Context ${index + 1} (${item?.source || "selection"}): ${cleaned.slice(0, 260)}`;
    })
    .join("\n");
}

function extractKeywords(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z_][a-z0-9_]*/g)?.filter((token) => token.length > 2) || []
  );
}

function extractIdentifierTerms(text) {
  const stop = new Set([
    "public", "private", "protected", "class", "interface", "static", "final", "return", "new",
    "if", "else", "for", "while", "true", "false", "null", "void", "int", "double", "float",
    "string", "boolean"
  ]);
  const out = [];
  const seen = new Set();
  const tokens = String(text || "").match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (stop.has(lower)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
    if (out.length >= 8) {
      break;
    }
  }
  return out;
}

function buildGroundedSummary(text, selectionScale = "snippet") {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return "No visible code was selected.";
  }

  if (selectionScale === "file") {
    return "This appears to be a full-file selection, so the explanation focuses on architecture: main responsibilities, major components, and how data/control move through the file.";
  }

  if (selectionScale === "block") {
    return "This is a multi-line block selection, so the explanation focuses on the logical sequence of operations and how each part contributes to the block's purpose.";
  }

  const patternDeclLines = lines.filter((line) => /^\s*private\s+static\s+final\s+Pattern\s+\w+\s*=\s*Pattern\.compile\(/.test(line));
  if (patternDeclLines.length >= Math.max(2, Math.floor(lines.length * 0.6))) {
    return "This snippet defines reusable token-matching rules that act as the parser's vocabulary; later parsing steps use these named patterns to recognize numbers, operators, and punctuation consistently.";
  }

  if (lines.length === 1 && /^\s*public\s+class\s+/.test(lines[0])) {
    return "This line creates the main class boundary, which groups all related parsing logic into one reusable unit.";
  }

  if (lines.some((line) => /^\s*if\s*\(/.test(line))) {
    return "This snippet contains decision logic that chooses a path based on runtime conditions.";
  }

  if (lines.some((line) => /\breturn\b/.test(line))) {
    return "This snippet computes and returns values to its caller as part of a larger workflow.";
  }

  return `This snippet contains ${lines.length} logical step(s) that contribute to the current part of the program flow.`;
}

function modelLooksGrounded(explanation, currentText) {
  const sample = `${explanation?.summary || ""} ${(Array.isArray(explanation?.notes) ? explanation.notes.join(" ") : "")}`;
  const codeTokens = [...extractKeywords(currentText)].slice(0, 12);
  if (codeTokens.length === 0) {
    return true;
  }

  const lowerSample = sample.toLowerCase();
  const overlaps = codeTokens.filter((token) => lowerSample.includes(token)).length;
  const ratio = overlaps / Math.max(1, Math.min(8, codeTokens.length));
  return ratio >= 0.25;
}

function buildFileLevelNotes(text) {
  const lines = String(text || "").split(/\r?\n/);
  const classNames = [...String(text || "").matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const methodCount = lines.filter((line) => /\)\s*\{\s*$/.test(line) && /(public|private|protected|static)/.test(line)).length;
  const patternCount = lines.filter((line) => /Pattern\.compile\(/.test(line)).length;

  const notes = [
    `File view: This selection is large, so we treat it as a whole-file explanation rather than a strict per-line walkthrough.`,
    `Structure: The file defines ${classNames.length || 0} class/type declaration(s) (${classNames.slice(0, 4).join(", ") || "none identified"}).`,
    `Behavior: It includes about ${methodCount} method-like blocks that implement the core workflow.`,
    patternCount > 0
      ? `Parsing setup: ${patternCount} pattern definitions act as token-recognition rules used later in parsing logic.`
      : "Parsing setup: No regex token setup detected in this selected file region.",
    "Execution model: Read from declarations (top) to operation methods (middle) to orchestration/demo code (bottom) to understand control flow."
  ];

  return notes;
}

function splitCodeTokens(line) {
  const tokens = String(line || "").match(/[A-Za-z_][A-Za-z0-9_]*|\d+|\S/g) || [];
  return tokens.slice(0, 14);
}

function normalizeNoteText(note) {
  return String(note || "")
    .toLowerCase()
    .replace(/line\s+\d+:/g, "line:")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeNotes(notes, maxCount = 10) {
  const out = [];
  const seen = new Set();
  for (const raw of notes || []) {
    const note = String(raw || "").trim();
    if (!note) {
      continue;
    }
    const key = normalizeNoteText(note);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(note);
    if (out.length >= maxCount) {
      break;
    }
  }
  return out;
}

function buildFlowBridgeNote(lines) {
  const trimmed = (lines || []).map((line) => String(line || "").trim()).filter(Boolean);
  if (!trimmed.length) {
    return "";
  }

  const hasDeclaration = trimmed.some((line) => /^\s*(public|private|protected)?\s*(static\s+)?[\w<>\[\]]+\s+[\w$]+\s*\(.*\)\s*\{?\s*$/.test(line));
  const hasCondition = trimmed.some((line) => /^\s*(if|else if|switch|for|while)\b/.test(line));
  const hasAssignment = trimmed.some((line) => /=/.test(line));
  const hasReturn = trimmed.some((line) => /^\s*return\b/.test(line));

  if (hasDeclaration && hasCondition && hasReturn) {
    return "Flow: The snippet declares behavior, branches on conditions, and returns an outcome to the caller.";
  }
  if (hasDeclaration && hasAssignment) {
    return "Flow: The snippet introduces a callable unit and sets up the values it will use during execution.";
  }
  if (hasAssignment && hasReturn) {
    return "Flow: The snippet computes intermediate values and then returns the final result.";
  }
  if (hasCondition) {
    return "Flow: The snippet's main role is choosing among execution paths based on runtime state.";
  }

  return "Flow: The lines work together as one step in the surrounding program logic.";
}

function describeJavaToken(token) {
  const keywordMap = {
    public: "access modifier: visible from any class",
    private: "access modifier: visible only inside the class",
    protected: "access modifier: visible to subclasses and same package",
    class: "type declaration keyword: defines a class",
    interface: "type declaration keyword: defines an interface contract",
    static: "class-level modifier: member belongs to the class, not an instance",
    final: "non-change modifier: value/reference cannot be reassigned",
    void: "return type meaning the method returns no value",
    return: "control keyword: sends a value back to the caller",
    new: "allocation keyword: creates a new object instance"
  };

  if (keywordMap[token]) {
    return `${token}=${keywordMap[token]}`;
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(token)) {
    return `${token}=type or class identifier`;
  }
  if (/^[a-z_][A-Za-z0-9_]*$/.test(token)) {
    return `${token}=identifier (name chosen by programmer)`;
  }
  if (/^\d+$/.test(token)) {
    return `${token}=integer literal value`;
  }
  if (token === "{") {
    return "{=opens a block scope";
  }
  if (token === "}") {
    return "}=closes a block scope";
  }
  if (token === "(") {
    return "(=opens parameter/expression grouping";
  }
  if (token === ")") {
    return ")=closes parameter/expression grouping";
  }
  if (token === ";") {
    return ";=statement terminator";
  }
  if (token === "=") {
    return "==assignment operator";
  }

  return `${token}=syntax symbol`;
}

function isTrivialStructuralLine(trimmed) {
  return /^[\[\]{}(),;]+$/.test(trimmed);
}

function lineImportance(trimmed) {
  if (!trimmed) {
    return 0;
  }
  if (isTrivialStructuralLine(trimmed)) {
    return 0;
  }
  if (/^private\s+static\s+final\s+Pattern\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*Pattern\.compile\(/.test(trimmed)) {
    return 3;
  }
  if (/^\s*public\s+class\s+/.test(trimmed)) {
    return 3;
  }
  if (/^\s*(public|private|protected)?\s*(static\s+)?[\w<>\[\]]+\s+[\w$]+\s*\(.*\)\s*\{?\s*$/.test(trimmed)) {
    return 3;
  }
  if (/^\s*(if|else if|for|while|switch|try|catch)\b/.test(trimmed)) {
    return 2;
  }
  if (/^\s*return\b/.test(trimmed)) {
    return 2;
  }
  if (/=/.test(trimmed)) {
    return 2;
  }
  return 1;
}

function buildLineTeachingNote(line, lineNumber) {
  const trimmed = String(line || "").trim();
  if (isTrivialStructuralLine(trimmed)) {
    if (trimmed.includes("{")) {
      return `Line ${lineNumber}: Opens a block (start of a grouped code region).`;
    }
    if (trimmed.includes("}")) {
      return `Line ${lineNumber}: Closes the current block.`;
    }
    if (trimmed.includes("(") || trimmed.includes(")") || trimmed.includes(",")) {
      return `Line ${lineNumber}: Structural punctuation for grouping/separating arguments.`;
    }
    return `Line ${lineNumber}: Structural punctuation.`;
  }

  const tokenHints = splitCodeTokens(trimmed)
    .map(describeJavaToken)
    .slice(0, 3)
    .join("; ");
  const tokenHintSuffix = tokenHints ? ` Key symbols: ${tokenHints}` : "";

  const patternDeclMatch = trimmed.match(/^private\s+static\s+final\s+Pattern\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*Pattern\.compile\((.+)\);?$/);
  if (patternDeclMatch) {
    const patName = patternDeclMatch[1];
    const patExpr = patternDeclMatch[2];
    return `Line ${lineNumber}: Defines token rule ${patName} using ${patExpr}; parser checks input against this rule later.${tokenHintSuffix}`;
  }

  if (/^\s*public\s+class\s+[A-Za-z_][A-Za-z0-9_]*\s*\{?\s*$/.test(trimmed)) {
    const className = (trimmed.match(/class\s+([A-Za-z_][A-Za-z0-9_]*)/) || [])[1] || "<ClassName>";
    return `Line ${lineNumber}: Declares class ${className}, the container for related parser behavior.${tokenHintSuffix}`;
  }
  if (/^\s*(interface|class|enum)\s+/.test(trimmed)) {
    return `Line ${lineNumber}: Defines a program type boundary.${tokenHintSuffix}`;
  }
  if (/^\s*(public|private|protected)?\s*(static\s+)?[\w<>\[\]]+\s+[\w$]+\s*\(.*\)\s*\{?\s*$/.test(trimmed)) {
    return `Line ${lineNumber}: Declares a method signature (name, inputs, and return type).${tokenHintSuffix}`;
  }
  if (/^\s*return\b/.test(trimmed)) {
    return `Line ${lineNumber}: Returns the computed value to the caller.${tokenHintSuffix}`;
  }
  if (/=/.test(trimmed)) {
    return `Line ${lineNumber}: Assigns/stores a value used by later logic.${tokenHintSuffix}`;
  }

  return `Line ${lineNumber}: ${trimmed}. This is a supporting step in the flow.${tokenHintSuffix}`;
}

function buildHumanLogicNotes(text, selectionScale = "snippet") {
  const lines = String(text).split(/\r?\n/);
  const notes = [];
  const limit = selectionScale === "block" ? 12 : 7;
  const entries = lines
    .map((line, index) => {
      const trimmed = String(line || "").trim();
      return {
        line,
        lineNumber: index + 1,
        trimmed,
        importance: lineImportance(trimmed)
      };
    })
    .filter((entry) => entry.trimmed.length > 0);

  const meaningful = entries.filter((entry) => entry.importance > 0);
  const trivial = entries.filter((entry) => entry.importance === 0);

  const selected = meaningful
    .slice()
    .sort((a, b) => b.importance - a.importance || a.lineNumber - b.lineNumber)
    .slice(0, limit);

  // Include at most one structural line, and only when needed for orientation.
  if (selected.length < Math.min(3, limit) && trivial.length > 0) {
    selected.push(trivial[0]);
  }

  if (selected.length === 0 && trivial.length > 0) {
    selected.push(trivial[0]);
  }

  selected
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .forEach((entry) => {
      notes.push(buildLineTeachingNote(entry.line, entry.lineNumber));
    });

  const bridge = buildFlowBridgeNote(selected.map((entry) => entry.line));
  if (bridge) {
    notes.push(bridge);
  }

  return notes;
}

function buildContextConnectionText(currentText, contextSelections) {
  if (!Array.isArray(contextSelections) || contextSelections.length === 0) {
    return "";
  }

  const currentKeywords = extractKeywords(currentText);
  const details = contextSelections
    .slice(-3)
    .map((item) => {
      const contextKeywords = extractKeywords(item.text);
      const overlap = [...contextKeywords].filter((token) => currentKeywords.has(token)).slice(0, 4);
      const label = item.label || "Earlier selection";
      if (overlap.length > 0) {
        return {
          connected: true,
          text: `${label} shares key identifiers (${overlap.join(", ")}) with this snippet.`
        };
      }
      return {
        connected: false,
        text: `${label} has no strong identifier overlap with this snippet, so treat it as separate context unless a higher-level workflow links them.`
      };
    });

  const anyConnected = details.some((item) => item.connected);
  const verdict = anyConnected ? "connected" : "separate";
  const links = details.map((item) => item.text).join(" ");

  return `Context verdict: ${verdict}. ${links}`;
}

function buildDrilldownPerspectiveNotes(currentText, drilldownTerm) {
  const term = String(drilldownTerm || "").trim();
  if (!term) {
    return [];
  }

  const lower = term.toLowerCase();
  const text = String(currentText || "");
  const notes = [];

  if (lower === "java") {
    notes.push("Drilldown (Java): This explanation uses Java semantics for the selected snippet.");
    if (/\binterface\b/.test(text)) {
      notes.push("Java focus: An interface defines a contract; implementing classes must provide the declared method(s).");
    }
    if (/\b(public|private|protected)\b/.test(text)) {
      notes.push("Java focus: Access modifiers control visibility across classes/packages.");
    }
    if (/\bstatic\b/.test(text)) {
      notes.push("Java focus: static members belong to the class, not object instances.");
    }
    if (/\bfinal\b/.test(text)) {
      notes.push("Java focus: final indicates non-reassignable references/values after initialization.");
    }
    if (/\bPattern\.compile\(/.test(text)) {
      notes.push("Java focus: Pattern.compile precompiles regex for repeated matching performance and readability.");
    }
    if (/\b\w+\s+\w+\s*\(.*\)\s*;/.test(text)) {
      notes.push("Java focus: Method signatures in interfaces are implicitly abstract unless default/static methods are used.");
    }
    return notes.slice(0, 3);
  }

  return [`Drilldown (${term}): The notes prioritize this concept in relation to the selected code.`];
}

function enforceContextConnection(explanation, currentText, contextSelections) {
  if (!Array.isArray(contextSelections) || contextSelections.length === 0) {
    return explanation;
  }

  const relation = buildContextConnectionText(currentText, contextSelections);
  const notes = Array.isArray(explanation.notes) ? [...explanation.notes] : [];
  const hasConnectionNote = notes.some((note) => /context connection|relates to|ties to|connects to/i.test(note));
  if (!hasConnectionNote && relation) {
    notes.unshift(relation);
  }

  const summary = String(explanation.summary || "");
  const hasSummaryConnection = /context|earlier selection|ingested|connect/i.test(summary);
  const nextSummary = hasSummaryConnection
    ? summary
    : `${summary}${summary ? " " : ""}${relation}`.trim();

  return {
    ...explanation,
    summary: nextSummary,
    notes
  };
}

function enforceHumanReadableStructure(explanation, currentText, options = {}) {
  const notes = Array.isArray(explanation.notes) ? [...explanation.notes] : [];
  const scale = options.selectionScale || determineSelectionScale(currentText);
  const preciseNotes = scale === "file"
    ? buildFileLevelNotes(currentText)
    : buildHumanLogicNotes(currentText, scale);
  const drilldownNotes = buildDrilldownPerspectiveNotes(currentText, options.drilldownTerm);
  const nonLineNotes = notes
    .filter((note) => !/^Line\s+\d+:/.test(note))
    .filter((note) => /context verdict|context connection|connected|separate/i.test(note));

  const groundedSummary = buildGroundedSummary(currentText, scale);
  const term = String(options.drilldownTerm || "").trim();
  const summary = term
    ? `${groundedSummary} Drilldown focus: ${term}.`
    : groundedSummary;
  const noteCap = scale === "file" ? 8 : scale === "block" ? 11 : 8;
  const mergedNotes = dedupeNotes([...nonLineNotes, ...drilldownNotes, ...preciseNotes], noteCap);

  return {
    ...explanation,
    selectionScale: scale,
    summary,
    notes: mergedNotes
  };
}

function enforceGroundedTerms(explanation, currentText) {
  return {
    ...explanation,
    terms: extractIdentifierTerms(currentText)
  };
}

async function callOpenRouter(config, extractedText, captureSource, options = {}) {
  const selectionScale = options.selectionScale || determineSelectionScale(extractedText);
  const numberedSnippet = buildLineNumberedSnippet(extractedText);
  const contextSnippet = buildContextSnippet(options.contextSelections);
  const drilldownTerm = options.drilldownTerm ? String(options.drilldownTerm) : "";
  const exactHighlightedCode = String(extractedText || "");
  const prompt = [
    `Teach the user what this highlighted code snippet is doing. It was captured from ${captureSource}.`,
    `Selection scale: ${selectionScale}.`,
    `Teaching depth: ${config.explanationLevel}.`,
    "Return strict JSON only using this schema:",
    '{"headline":"string","summary":"string","notes":["string"],"terms":["string"]}',
    "Explain only the selected code, not the whole file unless the selection directly depends on it.",
    "Make it feel like a concise tutoring explanation for a developer who may not know this language.",
    "Use universal programming concepts first (role, inputs, outputs, control flow, data flow), then mention language-specific details only when needed.",
    "The summary should state the role of the selected code in plain English.",
    selectionScale === "file"
      ? "Because this is a whole-file scale selection, produce architecture-level notes (components, responsibilities, data/control flow) instead of strict line-by-line detail."
      : "The notes must be line-by-line for the numbered selection. Each note must begin with 'Line N:' and explain that line in teaching language.",
    "Each line note must quote or clearly reference the exact selected line content so the user can map explanation to code without ambiguity.",
    "For each selected line, explain the purpose of the line and how it contributes to the overall logic.",
    "Only decode tokens/symbols that are important to understanding; avoid exhaustive token dumps.",
    "If the snippet has multiple lines, include one note per line in order.",
    "The terms array should contain a few important variable, method, class, or language terms from the selection.",
    contextSnippet
      ? "You are also given prior ingested selections. Use them only to connect meaning with the current snippet."
      : "",
    contextSnippet
      ? "You must explicitly state whether current and ingested snippets are connected or separate, and justify this with concrete evidence (shared identifiers, data flow, or explicit absence of overlap)."
      : "",
    contextSnippet ? "Ingested context:" : "",
    contextSnippet,
    drilldownTerm
      ? `Deep dive target term: ${drilldownTerm}. Ensure the explanation emphasizes this term and how it relates to the selected code.`
      : "",
    "Avoid filler, avoid repeating the raw code, and avoid markdown fences.",
    "Exact highlighted code (use this as the primary source of truth; do not infer missing lines):",
    "---BEGIN-HIGHLIGHT---",
    exactHighlightedCode,
    "---END-HIGHLIGHT---",
    "Numbered snippet:",
    numberedSnippet
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "X-Title": config.openRouterTitle
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are an educational coding tutor. Return strict JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status}).`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Model returned no content.");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    parsed = JSON.parse(content.slice(start, end + 1));
  }

  return {
    source: config.model,
    captureSource,
    extractedText,
    headline: parsed.headline || "What this code does",
    summary: parsed.summary || "",
    notes: Array.isArray(parsed.notes) ? parsed.notes : [],
    terms: Array.isArray(parsed.terms) ? parsed.terms : []
  };
}

async function buildExplanationFromText(config, extractedText, captureSource) {
  const options = arguments.length > 3 && arguments[3] ? arguments[3] : {};
  const selectionScale = options.selectionScale || determineSelectionScale(extractedText);
  if (!config.apiKey) {
    return enforceContextConnection(
      enforceHumanReadableStructure(
        fallbackExplanation(extractedText, config.explanationLevel, captureSource, { selectionScale }),
        extractedText,
        { selectionScale, drilldownTerm: options.drilldownTerm }
      ),
      extractedText,
      options.contextSelections
    );
  }

  try {
    const explanation = await callOpenRouter(config, extractedText, captureSource, {
      ...options,
      selectionScale
    });
    if (!modelLooksGrounded(explanation, extractedText)) {
      return enforceContextConnection(
        enforceGroundedTerms(
          enforceHumanReadableStructure(
            fallbackExplanation(extractedText, config.explanationLevel, captureSource, { selectionScale }),
            extractedText,
            { selectionScale, drilldownTerm: options.drilldownTerm }
          ),
          extractedText
        ),
        extractedText,
        options.contextSelections
      );
    }
    if (!explanation.notes || explanation.notes.length === 0) {
      return enforceContextConnection(
        enforceGroundedTerms(
          enforceHumanReadableStructure(
            fallbackExplanation(extractedText, config.explanationLevel, captureSource, { selectionScale }),
            extractedText,
            { selectionScale, drilldownTerm: options.drilldownTerm }
          ),
          extractedText
        ),
        extractedText,
        options.contextSelections
      );
    }
    return enforceContextConnection(
      enforceGroundedTerms(
        enforceHumanReadableStructure(explanation, extractedText, {
          selectionScale,
          drilldownTerm: options.drilldownTerm
        }),
        extractedText
      ),
      extractedText,
      options.contextSelections
    );
  } catch {
    return enforceContextConnection(
      enforceGroundedTerms(
        enforceHumanReadableStructure(
          fallbackExplanation(extractedText, config.explanationLevel, captureSource, { selectionScale }),
          extractedText,
          { selectionScale, drilldownTerm: options.drilldownTerm }
        ),
        extractedText
      ),
      extractedText,
      options.contextSelections
    );
  }
}

async function captureSelectedTextIfAvailable(electronApp) {
  const config = await readConfig(electronApp);
  const ctrlAIntentActive = await isCtrlASelectionGestureActive();

  const getTextStats = (text) => {
    const normalized = String(text || "");
    const nonEmptyLines = normalized.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    return {
      charCount: normalized.length,
      nonEmptyLines
    };
  };

  const looksLikeWholeDocument = (text) => {
    const stats = getTextStats(text);
    return stats.charCount > 2500 || stats.nonEmptyLines > 80;
  };

  const chooseBetterSelection = (primary, fallback) => {
    if (!primary && !fallback) {
      return null;
    }
    if (!primary) {
      return fallback;
    }
    if (!fallback) {
      return primary;
    }

    const primaryStats = getTextStats(primary.text);
    const fallbackStats = getTextStats(fallback.text);

    if (ctrlAIntentActive) {
      // During Ctrl+A, larger capture is typically the intentional full-document selection.
      if (primaryStats.charCount >= fallbackStats.charCount) {
        return primary;
      }
      return fallback;
    }

    // If the primary result looks like a whole document while clipboard is short,
    // trust clipboard as the likely real highlight.
    if (
      looksLikeWholeDocument(primary.text)
      && fallbackStats.charCount >= 2
      && fallbackStats.charCount <= Math.floor(primaryStats.charCount * 0.6)
    ) {
      return fallback;
    }

    return primary;
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const captureOnce = async () => {
    let uiaSelection = null;
    let clipboardSelection = null;

    if (config.useAccessibilityFirst) {
      const candidate = await captureSelectedTextViaAccessibility();
      if (candidate && candidate.text && candidate.text.trim().length >= 2) {
        uiaSelection = {
          text: candidate.text,
          source: candidate.source || "uia"
        };
      }
    }

    const clipboardCandidate = await captureSelectedTextViaClipboardProbe();
    if (clipboardCandidate && clipboardCandidate.text && clipboardCandidate.text.trim().length >= 2) {
      clipboardSelection = {
        text: clipboardCandidate.text,
        source: clipboardCandidate.source || "clipboard-probe"
      };
    }

    if (uiaSelection?.source === "uia-textpattern") {
      return chooseBetterSelection(uiaSelection, clipboardSelection);
    }

    if (uiaSelection?.source === "uia-valuepattern") {
      // ValuePattern often returns full editor content, not the true highlight.
      if (clipboardSelection) {
        return clipboardSelection;
      }
      if (ctrlAIntentActive) {
        return uiaSelection;
      }
      if (!looksLikeWholeDocument(uiaSelection.text)) {
        return uiaSelection;
      }
      return null;
    }

    if (clipboardSelection) {
      return clipboardSelection;
    }

    if (uiaSelection) {
      return uiaSelection;
    }

    return null;
  };

  let best = null;
  const attempts = 3;
  for (let i = 0; i < attempts; i += 1) {
    const candidate = await captureOnce();
    if (candidate) {
      if (!best) {
        best = candidate;
      } else {
        best = chooseBetterSelection(best, candidate);
      }

      const isHighConfidence = candidate.source === "uia-textpattern"
        || candidate.source === "clipboard-probe";
      if (isHighConfidence && !looksLikeWholeDocument(candidate.text)) {
        return candidate;
      }
    }

    if (i < attempts - 1) {
      await wait(80 + (i * 50));
    }
  }

  return best;
}

async function explainSelectedTextIfAvailable(electronApp) {
  const config = await readConfig(electronApp);
  const selection = await captureSelectedTextIfAvailable(electronApp);
  if (!selection || !selection.text) {
    return null;
  }

  return buildExplanationFromText(config, selection.text, selection.source || "uia");
}

async function explainSelectionWithContext(electronApp, selectionText, captureSource, options = {}) {
  const config = await readConfig(electronApp);
  return buildExplanationFromText(config, selectionText, captureSource || "uia", options);
}

async function explainDrilldownWithContext(electronApp, baseSelectionText, drilldownTerm, contextSelections = []) {
  const config = await readConfig(electronApp);
  return buildExplanationFromText(config, baseSelectionText, "branch-drilldown", {
    contextSelections,
    drilldownTerm,
    selectionScale: determineSelectionScale(baseSelectionText)
  });
}

async function explainCapturedRegion(electronApp, bounds) {
  const config = await readConfig(electronApp);
  const crop = clampBounds(bounds);
  const screenshotBuffer = await screenshot({ format: "png" });
  const croppedBuffer = await sharp(screenshotBuffer)
    .extract(crop)
    .png()
    .toBuffer();

  const extractedText = await extractTextFromImage(croppedBuffer);
  if (!extractedText) {
    throw new Error("No text was detected in the selected region.");
  }

  return buildExplanationFromText(config, extractedText, "screen-ocr");
}

module.exports = {
  explainCapturedRegion,
  explainSelectedTextIfAvailable,
  captureSelectedTextIfAvailable,
  explainSelectionWithContext,
  explainDrilldownWithContext
};
