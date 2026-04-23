#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const path = require("path");
const url = require("url");

const HOST = process.env.OPENCLAW_SESSION_VIEWER_HOST || "127.0.0.1";
const PORT = Number(process.env.OPENCLAW_SESSION_VIEWER_PORT || "4318");
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const AGENTS_DIR = path.join(ROOT_DIR, ".openclaw", "agents");
const PUBLIC_DIR = path.join(__dirname, "public");
const OPENCLAW_CONFIG_PATH = path.join(ROOT_DIR, ".openclaw", "openclaw.json");
const SESSION_ROOTS_CONFIG_PATH = path.join(__dirname, "session-roots.json");
const MAX_COMPARE_COUNT = 4;
const MAX_PREVIEW_MESSAGES = 4;
const INTERNAL_CONTEXT_START = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_COMPLETION_MARKER = "[Internal task completion event]";
const ARCHIVE_SESSION_FILE_RE = /^(?<sessionId>[^.]+)\.jsonl\.(?<reason>[^.]+)\.(?<archivedAt>.+)$/;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readRuntimeConfig() {
  if (!(await fileExists(OPENCLAW_CONFIG_PATH))) {
    return null;
  }
  try {
    return await readJson(OPENCLAW_CONFIG_PATH);
  } catch {
    return null;
  }
}

async function readSessionRootsConfig() {
  if (!(await fileExists(SESSION_ROOTS_CONFIG_PATH))) {
    return { agents: {} };
  }
  try {
    const config = await readJson(SESSION_ROOTS_CONFIG_PATH);
    return config && typeof config === "object" ? config : { agents: {} };
  } catch {
    return { agents: {} };
  }
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function toIso(timestamp) {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeSnippet(text, maxLength = 180) {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function extractTextSegments(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  const results = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      results.push(block.text);
    }
  }
  return results;
}

function createMessageSnippet(message) {
  const texts = extractTextSegments(message?.content);
  return normalizeSnippet(texts.join("\n"));
}

function extractTextBlocks(message) {
  if (!message || !Array.isArray(message.content)) {
    return [];
  }
  return message.content
    .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

function parseInternalCompletionText(text) {
  if (!text || !text.includes(INTERNAL_COMPLETION_MARKER)) {
    return null;
  }
  const getValue = (label) => {
    const match = text.match(new RegExp(`${label}:\\s*(.+)`));
    return match ? match[1].trim() : null;
  };
  return {
    source: getValue("source"),
    sessionKey: getValue("session_key"),
    sessionId: getValue("session_id"),
    taskType: getValue("type"),
    task: getValue("task"),
    status: getValue("status"),
  };
}

async function readSessionEvents(sessionFile) {
  const raw = await fsp.readFile(sessionFile, "utf8");
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch (error) {
      events.push({
        type: "parse_error",
        error: String(error),
        raw: trimmed,
      });
    }
  }
  return events;
}

function parseArchiveSessionFileName(fileName) {
  const match = fileName.match(ARCHIVE_SESSION_FILE_RE);
  if (!match?.groups) {
    return null;
  }
  return {
    sessionId: match.groups.sessionId,
    reason: match.groups.reason,
    archivedAt: match.groups.archivedAt,
  };
}

function normalizeArchiveTimestamp(timestamp) {
  if (!timestamp) {
    return null;
  }
  return timestamp.replace(/T(\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)$/, "T$1:$2:$3");
}

function isSessionTranscriptFile(fileName) {
  return fileName.endsWith(".jsonl") || Boolean(parseArchiveSessionFileName(fileName));
}

function createRecordId(sessionId, archive = null) {
  if (!archive?.reason || !archive?.archivedAt) {
    return sessionId;
  }
  return `${sessionId}@${archive.reason}@${archive.archivedAt}`;
}

function inferArchiveType(events) {
  for (const event of events) {
    if (event.type !== "message") {
      continue;
    }
    const message = event.message || {};
    if (message.role !== "user") {
      continue;
    }
    const texts = extractTextSegments(message.content);
    if (texts.some((text) => text.includes("[Subagent Context]"))) {
      return "subagent";
    }
  }
  return "session";
}

function inferArchiveMetadata(sessionFile, events, archive) {
  const timestamps = events
    .map((event) => toIso(event.timestamp || null))
    .filter(Boolean);

  let provider = null;
  let model = null;
  let workspaceDir = null;

  for (const event of events) {
    if (event.type === "session" && typeof event.cwd === "string" && event.cwd) {
      workspaceDir = workspaceDir || event.cwd;
      continue;
    }
    if (event.type === "model_change") {
      provider = provider || event.provider || null;
      model = model || event.modelId || null;
      continue;
    }
    if (event.type !== "message") {
      continue;
    }
    const message = event.message || {};
    provider = provider || message.provider || null;
    model = model || message.model || null;
  }

  const archiveInfo = archive
    ? {
        reason: archive.reason,
        archivedAt: archive.archivedAt,
        archivedAtIso: toIso(normalizeArchiveTimestamp(archive.archivedAt)),
      }
    : null;

  return {
    sessionId: archive?.sessionId || path.basename(sessionFile, ".jsonl"),
    sessionFile,
    startedAt: timestamps[0] || null,
    updatedAt: timestamps[timestamps.length - 1] || null,
    status: archiveInfo ? `archived/${archiveInfo.reason}` : "archived",
    systemPromptReport: {
      provider,
      model,
      workspaceDir,
    },
    archive: archiveInfo,
    typeTagOverride: inferArchiveType(events),
  };
}

function listConfiguredAgents(runtimeConfig, sessionRootsConfig) {
  const configured = new Set();
  const runtimeAgents = Array.isArray(runtimeConfig?.agents?.list) ? runtimeConfig.agents.list : [];
  for (const agent of runtimeAgents) {
    if (agent?.id) {
      configured.add(agent.id);
    }
  }
  const mappedAgents =
    sessionRootsConfig?.agents && typeof sessionRootsConfig.agents === "object"
      ? Object.keys(sessionRootsConfig.agents)
      : [];
  for (const agentId of mappedAgents) {
    configured.add(agentId);
  }
  return [...configured].sort();
}

function resolveAgentSessionRoot(agentId, sessionRootsConfig) {
  const configuredEntry = sessionRootsConfig?.agents?.[agentId];
  const configuredRoot =
    typeof configuredEntry === "string" ? configuredEntry : configuredEntry?.sessionRoot;
  if (configuredRoot) {
    return {
      agentId,
      sessionRoot: path.isAbsolute(configuredRoot) ? configuredRoot : path.resolve(ROOT_DIR, configuredRoot),
      source: "viewer-config",
    };
  }
  return {
    agentId,
    sessionRoot: path.join(AGENTS_DIR, agentId, "sessions"),
    source: "fallback-convention",
  };
}

function getSessionRootSpec(index, agentId) {
  return index?.sessionRoots?.[agentId] || {
    agentId,
    sessionRoot: path.join(AGENTS_DIR, agentId, "sessions"),
    source: "fallback-convention",
  };
}

function classifyAssistantSegments(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((block, index) => {
    if (!block || typeof block !== "object") {
      return { id: `unknown-${index}`, type: "unknown", raw: block };
    }
    if (block.type === "text") {
      return {
        id: `text-${index}`,
        type: "text",
        text: typeof block.text === "string" ? block.text : "",
      };
    }
    if (block.type === "thinking") {
      return {
        id: `thinking-${index}`,
        type: "thinking",
        text: typeof block.thinking === "string" ? block.thinking : "",
        signature: block.thinkingSignature || null,
      };
    }
    if (block.type === "toolCall") {
      return {
        id: block.id || `tool-call-${index}`,
        type: "tool_call",
        toolCallId: block.id || null,
        name: block.name || "unknown",
        arguments: block.arguments || null,
        partialJson: block.partialJson || null,
      };
    }
    return {
      id: block.id || `raw-${index}`,
      type: block.type || "unknown",
      raw: block,
    };
  });
}

function createSystemEvent(event) {
  const timestamp = event.timestamp || null;
  if (event.type === "model_change") {
    return {
      kind: "system_event",
      eventType: "model_change",
      label: "Model changed",
      timestamp,
      details: {
        provider: event.provider || null,
        modelId: event.modelId || null,
      },
      raw: event,
    };
  }
  if (event.type === "thinking_level_change") {
    return {
      kind: "system_event",
      eventType: "thinking_level_change",
      label: "Thinking level changed",
      timestamp,
      details: {
        thinkingLevel: event.thinkingLevel || null,
      },
      raw: event,
    };
  }
  if (event.type === "custom") {
    return {
      kind: "system_event",
      eventType: "custom",
      label: event.customType ? `Custom: ${event.customType}` : "Custom event",
      timestamp,
      details: event.data || null,
      raw: event,
    };
  }
  if (event.type === "parse_error") {
    return {
      kind: "system_event",
      eventType: "parse_error",
      label: "Parse error",
      timestamp: null,
      details: {
        error: event.error,
        raw: event.raw,
      },
      raw: event,
    };
  }
  return {
    kind: "system_event",
    eventType: event.type || "unknown",
    label: event.type || "Unknown event",
    timestamp,
    details: event,
    raw: event,
  };
}

function toEpochMs(timestamp) {
  if (!timestamp) {
    return null;
  }
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const value = new Date(timestamp).getTime();
  return Number.isNaN(value) ? null : value;
}

function inferAssistantDurationMs(event, message) {
  const eventMs = toEpochMs(event.timestamp);
  const messageMs = toEpochMs(message.timestamp);
  if (eventMs == null || messageMs == null) {
    return null;
  }
  const duration = eventMs - messageMs;
  return duration >= 0 ? duration : null;
}

function isModelApiMessage(message, event) {
  const provider = message.provider || event.provider || null;
  const model = message.model || event.model || null;
  if (!provider && !model) {
    return false;
  }
  if (provider === "openclaw") {
    return false;
  }
  if (["gateway-injected", "delivery-mirror"].includes(model)) {
    return false;
  }
  return true;
}

function buildSessionView(events, summary) {
  const timeline = [];
  const toolCallById = new Map();
  const children = [];
  const childCompletions = [];
  let sessionMeta = null;

  for (const event of events) {
    if (event.type === "session") {
      sessionMeta = {
        id: event.id || summary.sessionId,
        version: event.version || null,
        timestamp: event.timestamp || null,
        cwd: event.cwd || null,
      };
      continue;
    }

    if (event.type !== "message") {
      timeline.push(createSystemEvent(event));
      continue;
    }

    const message = event.message || {};
    const role = message.role || "unknown";

    if (role === "assistant") {
      const segments = classifyAssistantSegments(message.content);
      for (const segment of segments) {
        if (segment.type === "tool_call" && segment.toolCallId) {
          toolCallById.set(segment.toolCallId, segment);
        }
        if (segment.type === "tool_call" && segment.name === "sessions_spawn") {
          children.push({
            trigger: "sessions_spawn",
            toolCallId: segment.toolCallId,
            requestedAgentId: segment.arguments?.agentId || null,
            label: segment.arguments?.label || null,
            mode: segment.arguments?.mode || null,
            runtime: segment.arguments?.runtime || null,
            task: segment.arguments?.task || null,
            accepted: null,
            resolved: null,
          });
        }
      }
      timeline.push({
        kind: "message",
        role,
        id: event.id || null,
        parentId: event.parentId || null,
        timestamp: event.timestamp || message.timestamp || null,
        durationMs: inferAssistantDurationMs(event, message),
        isModelApi: isModelApiMessage(message, event),
        usage: message.usage || event.usage || null,
        provider: message.provider || event.provider || null,
        model: message.model || event.model || null,
        stopReason: message.stopReason || event.stopReason || null,
        segments,
        raw: event,
      });
      continue;
    }

    if (role === "user") {
      const textBlocks = extractTextBlocks(message);
      for (const text of textBlocks) {
        const completion = parseInternalCompletionText(text);
        if (completion) {
          childCompletions.push({
            ...completion,
            timestamp: event.timestamp || message.timestamp || null,
          });
        }
      }
      timeline.push({
        kind: "message",
        role,
        id: event.id || null,
        parentId: event.parentId || null,
        timestamp: event.timestamp || message.timestamp || null,
        segments: extractTextSegments(message.content).map((text, index) => ({
          id: `text-${index}`,
          type: "text",
          text,
        })),
        raw: event,
      });
      continue;
    }

    if (role === "toolResult") {
      const relatedCall = toolCallById.get(message.toolCallId || "");
      if (message.toolName === "sessions_spawn" && relatedCall?.name === "sessions_spawn") {
        const target = children.find((child) => child.toolCallId === message.toolCallId);
        if (target) {
          target.accepted = {
            status: message.details?.status || null,
            childSessionKey: message.details?.childSessionKey || null,
            runId: message.details?.runId || null,
            mode: message.details?.mode || null,
            modelApplied: message.details?.modelApplied ?? null,
          };
        }
      }
      timeline.push({
        kind: "tool_result",
        role,
        id: event.id || null,
        parentId: event.parentId || null,
        timestamp: event.timestamp || message.timestamp || null,
        toolCallId: message.toolCallId || null,
        toolName: message.toolName || relatedCall?.name || null,
        isError: Boolean(message.isError),
        details: message.details || null,
        content: extractTextSegments(message.content),
        raw: event,
      });
      continue;
    }

    timeline.push({
      kind: "message",
      role,
      id: event.id || null,
      parentId: event.parentId || null,
      timestamp: event.timestamp || message.timestamp || null,
      segments: [
        {
          id: "raw-message",
          type: "unknown",
          raw: message,
        },
      ],
      raw: event,
    });
  }

  for (const child of children) {
    if (!child.accepted?.childSessionKey) {
      continue;
    }
    const completion = childCompletions.find(
      (candidate) => candidate.sessionKey && candidate.sessionKey === child.accepted.childSessionKey
    );
    if (completion) {
      child.completion = completion;
    }
  }

  return {
    session: {
      ...summary,
      sessionMeta,
    },
    relationships: {
      parent: summary.parentLink || null,
      children,
      childCompletions,
    },
    timeline,
  };
}

function createSessionSummary(agentId, sessionKey, metadata) {
  const sessionFile = metadata.sessionFile || "";
  const archive = metadata.archive || null;
  const sessionId = metadata.sessionId || path.basename(sessionFile, ".jsonl");
  return {
    agentId,
    sessionKey,
    sessionId,
    recordId: metadata.recordId || createRecordId(sessionId, archive),
    sessionFile,
    updatedAt: metadata.updatedAt || null,
    updatedAtIso: toIso(metadata.updatedAt || null),
    startedAt: metadata.startedAt || null,
    startedAtIso: toIso(metadata.startedAt || null),
    status: metadata.status || null,
    provider: metadata.systemPromptReport?.provider || null,
    model: metadata.systemPromptReport?.model || null,
    chatType: metadata.chatType || metadata.origin?.chatType || null,
    originProvider: metadata.origin?.provider || null,
    originSurface: metadata.origin?.surface || null,
    workspaceDir: metadata.systemPromptReport?.workspaceDir || null,
    totalTokensFresh: metadata.totalTokensFresh ?? null,
    cacheRead: metadata.cacheRead ?? null,
    cacheWrite: metadata.cacheWrite ?? null,
    abortedLastRun: metadata.abortedLastRun ?? null,
    compactionCount: metadata.compactionCount ?? null,
    archive,
    isArchived: Boolean(archive),
    typeTagOverride: metadata.typeTagOverride || null,
    summary: {
      preview: "",
      userMessages: 0,
      assistantMessages: 0,
      toolResults: 0,
      hasThinking: false,
      hasToolCall: false,
      hasError: false,
    },
  };
}

function applySpawnMetadata(summary, sessionKey, metadata) {
  if (sessionKey?.includes(":subagent:") || summary.typeTagOverride === "subagent") {
    summary.spawnInfo = {
      spawnedBy: metadata?.spawnedBy || null,
      label: metadata?.label || null,
      spawnDepth: metadata?.spawnDepth ?? null,
      subagentRole: metadata?.subagentRole || null,
      subagentControlScope: metadata?.subagentControlScope || null,
    };
  } else {
    summary.spawnInfo = null;
  }
  return summary;
}

function classifySessionType(session, runtimeConfig) {
  if (session.typeTagOverride) {
    return session.typeTagOverride;
  }
  const key = session.sessionKey || "";
  if (!key) {
    return session.isArchived ? "archived" : "orphan";
  }
  if (key.includes(":subagent:")) {
    return "subagent";
  }
  if (/:main$/.test(key)) {
    return "main";
  }

  const bindings = runtimeConfig?.bindings || [];
  const isBoundDirect = bindings.some((binding) => binding.agentId === session.agentId);
  if (isBoundDirect && key.includes(":direct:")) {
    return "direct";
  }
  if (key.includes(":direct:")) {
    return "direct";
  }
  return "session";
}

function classifySessionScope(session, runtimeConfig) {
  if (session.isArchived && session.typeTag !== "subagent") {
    return "archived";
  }
  if (session.typeTag === "subagent") {
    return "child";
  }
  if (session.typeTag === "main") {
    return "primary";
  }
  if (session.typeTag === "direct") {
    const dmScope = runtimeConfig?.session?.dmScope || null;
    return dmScope ? `direct/${dmScope}` : "direct";
  }
  return "other";
}

function getSessionWindow(session) {
  const start = session?.startedAt || null;
  const end = session?.updatedAt || null;
  return {
    start,
    end,
  };
}

function isWithinStrongWindow(parentSession, childSession) {
  const parentWindow = getSessionWindow(parentSession);
  const childStart = childSession?.startedAt || null;
  if (!parentWindow.start || !parentWindow.end || !childStart) {
    return false;
  }
  return childStart >= parentWindow.start && childStart <= parentWindow.end;
}

async function collectSessionStats(summary) {
  const sessionFile = summary.sessionFile;
  if (!(await fileExists(sessionFile))) {
    return summary;
  }

  const events = await readSessionEvents(sessionFile);
  const previewParts = [];
  let userMessages = 0;
  let assistantMessages = 0;
  let toolResults = 0;
  let hasThinking = false;
  let hasToolCall = false;
  let hasError = false;

  for (const event of events) {
    if (event.type !== "message") {
      continue;
    }
    const message = event.message || {};
    if (message.role === "user") {
      userMessages += 1;
      const snippet = createMessageSnippet(message);
      if (snippet && previewParts.length < MAX_PREVIEW_MESSAGES) {
        previewParts.push(snippet);
      }
      continue;
    }
    if (message.role === "assistant") {
      assistantMessages += 1;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        if (block.type === "thinking" && block.thinking) {
          hasThinking = true;
        }
        if (block.type === "toolCall") {
          hasToolCall = true;
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      toolResults += 1;
      if (message.isError || message.details?.status === "error") {
        hasError = true;
      }
    }
  }

  return {
    ...summary,
    summary: {
      preview: previewParts.join("  "),
      userMessages,
      assistantMessages,
      toolResults,
      hasThinking,
      hasToolCall,
      hasError,
    },
  };
}

async function loadIndex() {
  const sessions = [];
  const sessionIndexByKey = new Map();
  const runtimeConfig = await readRuntimeConfig();
  const sessionRootsConfig = await readSessionRootsConfig();
  const agentIds = listConfiguredAgents(runtimeConfig, sessionRootsConfig);
  const sessionRoots = {};

  for (const agentId of agentIds) {
    const rootSpec = resolveAgentSessionRoot(agentId, sessionRootsConfig);
    sessionRoots[agentId] = rootSpec;
    const sessionsPath = path.join(rootSpec.sessionRoot, "sessions.json");
    if (!(await fileExists(sessionsPath))) {
      continue;
    }
    let sessionMap;
    try {
      sessionMap = await readJson(sessionsPath);
    } catch (error) {
      sessions.push({
        agentId,
        sessionKey: "__index_error__",
        sessionId: null,
        sessionFile: sessionsPath,
        status: "index_error",
        updatedAt: null,
        updatedAtIso: null,
        startedAt: null,
        startedAtIso: null,
        provider: null,
        model: null,
        chatType: null,
        originProvider: null,
        originSurface: null,
        workspaceDir: null,
        error: String(error),
        summary: {
          preview: "",
          userMessages: 0,
          assistantMessages: 0,
          toolResults: 0,
          hasThinking: false,
          hasToolCall: false,
          hasError: true,
        },
      });
      continue;
    }

    const sessionsDir = rootSpec.sessionRoot;
    const knownFiles = new Set();

    for (const [sessionKey, metadata] of Object.entries(sessionMap)) {
      const baseSummary = createSessionSummary(agentId, sessionKey, metadata);
      const enriched = await collectSessionStats(baseSummary);
      applySpawnMetadata(enriched, sessionKey, metadata);
      enriched.typeTag = classifySessionType(enriched, runtimeConfig);
      enriched.scopeTag = classifySessionScope(enriched, runtimeConfig);
      sessions.push(enriched);
      sessionIndexByKey.set(sessionKey, enriched);
      if (metadata?.sessionFile) {
        knownFiles.add(path.basename(metadata.sessionFile));
      }
    }

    let sessionEntries = [];
    try {
      sessionEntries = await fsp.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      sessionEntries = [];
    }

    for (const fileEntry of sessionEntries) {
      if (!fileEntry.isFile()) {
        continue;
      }
      const archive = parseArchiveSessionFileName(fileEntry.name);
      if (!archive) {
        continue;
      }
      const sessionFile = path.join(sessionsDir, fileEntry.name);
      const events = await readSessionEvents(sessionFile);
      const archiveMetadata = inferArchiveMetadata(sessionFile, events, archive);
      const sessionKey = `archive:${agentId}:${archive.reason}:${archive.sessionId}:${archive.archivedAt}`;
      const baseSummary = createSessionSummary(agentId, sessionKey, archiveMetadata);
      const enriched = await collectSessionStats(baseSummary);
      applySpawnMetadata(enriched, sessionKey, archiveMetadata);
      enriched.typeTag = classifySessionType(enriched, runtimeConfig);
      enriched.scopeTag = classifySessionScope(enriched, runtimeConfig);
      sessions.push(enriched);
    }
  }

  const sessionIdToSummary = new Map(sessions.map((session) => [session.recordId || session.sessionId, session]));
  for (const session of sessions) {
    if (session.spawnInfo?.spawnedBy) {
      const parent = sessionIndexByKey.get(session.spawnInfo.spawnedBy);
      if (parent) {
        session.parentLink = {
          agentId: parent.agentId,
          sessionKey: parent.sessionKey,
          sessionId: parent.sessionId,
          recordId: parent.recordId || parent.sessionId,
          label: session.spawnInfo.label || null,
          via: "spawnedBy",
        };
      } else {
        session.parentLink = {
          agentId: null,
          sessionKey: session.spawnInfo.spawnedBy,
          sessionId: null,
          label: session.spawnInfo.label || null,
          via: "spawnedBy",
        };
      }
    } else {
      session.parentLink = null;
    }
  }

  sessions.sort((a, b) => {
    const left = a.updatedAt || 0;
    const right = b.updatedAt || 0;
    return right - left;
  });

  const agents = Array.from(new Set(sessions.map((item) => item.agentId))).sort();
  const providers = Array.from(new Set(sessions.map((item) => item.provider).filter(Boolean))).sort();
  const models = Array.from(new Set(sessions.map((item) => item.model).filter(Boolean))).sort();
  const statuses = Array.from(new Set(sessions.map((item) => item.status).filter(Boolean))).sort();

  return {
    rootDir: ROOT_DIR,
    agentsDir: AGENTS_DIR,
    sessionRootsConfigPath: SESSION_ROOTS_CONFIG_PATH,
    sessionRoots,
    maxCompareCount: MAX_COMPARE_COUNT,
    generatedAt: new Date().toISOString(),
    stats: {
      agentCount: agents.length,
      sessionCount: sessions.length,
    },
    runtime: {
      sessionDmScope: runtimeConfig?.session?.dmScope || null,
      bindingCount: Array.isArray(runtimeConfig?.bindings) ? runtimeConfig.bindings.length : 0,
    },
    filters: {
      agents,
      providers,
      models,
      statuses,
    },
    sessions,
    lookup: {
      bySessionIdCount: sessionIdToSummary.size,
      bySessionKeyCount: sessionIndexByKey.size,
    },
  };
}

async function resolveSessionView(index, agentId, sessionId) {
  const recordId = arguments[3] || null;
  const rootSpec = getSessionRootSpec(index, agentId);
  const indexedSummary = index.sessions.find(
    (session) =>
      session.agentId === agentId &&
      ((recordId && session.recordId === recordId) || (!recordId && session.sessionId === sessionId))
  );
  const sessionFile =
    indexedSummary?.sessionFile || path.join(rootSpec.sessionRoot, `${sessionId}.jsonl`);
  if (!(await fileExists(sessionFile))) {
    return null;
  }
  const sessionsIndexPath = path.join(rootSpec.sessionRoot, "sessions.json");
  let sessionMap = {};
  if (await fileExists(sessionsIndexPath)) {
    sessionMap = await readJson(sessionsIndexPath);
  }
  const metadataEntry = Object.entries(sessionMap).find(([, metadata]) => metadata.sessionId === sessionId);
  const summary =
    indexedSummary ||
    createSessionSummary(
      agentId,
      metadataEntry?.[0] || `${agentId}:${sessionId}`,
      metadataEntry?.[1] || { sessionId, sessionFile }
    );
  const enrichedSummary = indexedSummary ? { ...indexedSummary } : await collectSessionStats(summary);
  applySpawnMetadata(enrichedSummary, metadataEntry?.[0] || summary.sessionKey || "", metadataEntry?.[1] || null);
  if (enrichedSummary.spawnInfo?.spawnedBy) {
    enrichedSummary.parentLink = {
      agentId: null,
      sessionKey: enrichedSummary.spawnInfo.spawnedBy,
      sessionId: null,
      recordId: null,
      label: enrichedSummary.spawnInfo.label || null,
      via: "spawnedBy",
    };
  } else {
    enrichedSummary.parentLink = null;
  }
  const events = await readSessionEvents(sessionFile);
  const view = buildSessionView(events, enrichedSummary);
  view.relationships.children = view.relationships.children.map((child) => {
    const sessionKey = child.accepted?.childSessionKey || child.completion?.sessionKey || null;
    const resolved = sessionKey ? index.sessions.find((item) => item.sessionKey === sessionKey) : null;
    return {
      ...child,
      resolved: resolved
        ? {
            agentId: resolved.agentId,
            sessionKey: resolved.sessionKey,
            sessionId: resolved.sessionId,
            recordId: resolved.recordId || resolved.sessionId,
            status: resolved.status || child.completion?.status || null,
            updatedAt: resolved.updatedAt || null,
            label: resolved.spawnInfo?.label || child.label || null,
          }
        : null,
    };
  });
  view.relationships.childCompletions = view.relationships.childCompletions.map((completion) => {
    const resolved = completion.sessionId ? index.sessions.find((item) => item.sessionId === completion.sessionId) : null;
    return {
      ...completion,
      resolved: resolved
        ? {
            agentId: resolved.agentId,
            sessionKey: resolved.sessionKey,
            sessionId: resolved.sessionId,
            recordId: resolved.recordId || resolved.sessionId,
            status: resolved.status || completion.status || null,
            updatedAt: resolved.updatedAt || null,
          }
        : null,
    };
  });
  return view;
}

async function findActualParentSession(index, childSummary) {
  if (!childSummary?.spawnInfo?.spawnedBy || !childSummary?.sessionId) {
    return null;
  }
  const parentKey = childSummary.spawnInfo.spawnedBy;
  const parts = parentKey.split(":");
  if (parts.length < 2) {
    return null;
  }
  const parentAgentId = parts[1];
  const candidates = [];
  for (const session of index.sessions.filter((item) => item.agentId === parentAgentId)) {
    const filePath = session.sessionFile;
    let raw;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    if (
      raw.includes(childSummary.sessionId) ||
      raw.includes(childSummary.sessionKey) ||
      raw.includes(parentKey)
    ) {
      candidates.push({
        filePath,
        sessionId: session.sessionId,
        recordId: session.recordId,
      });
    }
  }
  for (const candidate of candidates) {
    const parentView = await resolveSessionView(index, parentAgentId, candidate.sessionId, candidate.recordId);
    if (!parentView) {
      continue;
    }
    const matches = parentView.relationships.children.some(
      (child) =>
        child.resolved?.sessionId === childSummary.sessionId ||
        child.accepted?.childSessionKey === childSummary.sessionKey ||
        child.completion?.sessionId === childSummary.sessionId
    );
    if (matches) {
      return parentView;
    }
  }
  return null;
}

function toChainNode(session, relation) {
  return {
    key: `${session.agentId}::${session.recordId || session.sessionId}`,
    agentId: session.agentId,
    sessionId: session.sessionId,
    recordId: session.recordId || session.sessionId,
    sessionKey: session.sessionKey,
    status: session.status || null,
    updatedAt: session.updatedAt || null,
      label: session.spawnInfo?.label || session.parentLink?.label || null,
      relation,
  };
}

async function buildChain(index, agentId, sessionId) {
  const recordId = arguments[3] || null;
  const focusSummary = index.sessions.find(
    (session) =>
      session.agentId === agentId &&
      ((recordId && session.recordId === recordId) || (!recordId && session.sessionId === sessionId))
  );
  if (!focusSummary) {
    return null;
  }
  const focusView = await resolveSessionView(index, agentId, sessionId, focusSummary.recordId);
  if (!focusView) {
    return null;
  }

  const nodes = new Map();
  const edges = [];

  function ensureNode(sessionLike, relation) {
    if (!sessionLike?.agentId || !sessionLike?.sessionId) {
      return null;
    }
    const node = toChainNode(sessionLike, relation);
    const existing = nodes.get(node.key);
    if (!existing || relation === "focus") {
      nodes.set(node.key, node);
    }
    return nodes.get(node.key);
  }

  function addEdge(fromSession, toSession, type, meta = {}) {
    const isFocusSession = (session) =>
      session.agentId === agentId &&
      ((recordId && (session.recordId || session.sessionId) === recordId) || (!recordId && session.sessionId === sessionId));
    const fromNode = ensureNode(fromSession, isFocusSession(fromSession) ? "focus" : "related");
    const toNode = ensureNode(toSession, isFocusSession(toSession) ? "focus" : "related");
    if (!fromNode || !toNode) {
      return;
    }
    edges.push({
      from: fromNode.key,
      to: toNode.key,
      type,
      ...meta,
    });
  }

  ensureNode(focusSummary, "focus");

  let parentView = null;
  if (focusSummary.spawnInfo?.spawnedBy) {
    parentView = await findActualParentSession(index, focusSummary);
    if (parentView?.session?.agentId && parentView?.session?.sessionId) {
      addEdge(parentView.session, focusSummary, "parent_child", {
        label: focusSummary.spawnInfo.label || null,
        via: "session_transcript",
      });
    }
  }

  const descendants = [];
  const strongDescendantKeys = new Set();
  for (const child of focusView.relationships.children) {
    if (!child.resolved?.agentId || !child.resolved?.sessionId) {
      continue;
    }
    descendants.push(child.resolved);
    strongDescendantKeys.add(`${child.resolved.agentId}::${child.resolved.sessionId}`);
    addEdge(focusSummary, child.resolved, "parent_child", {
      label: child.label || child.resolved.label || child.completion?.task || null,
      via: "session_transcript",
    });
  }

  const extendedDescendants = index.sessions.filter((session) => {
    if (!session.spawnInfo?.spawnedBy) {
      return false;
    }
    if (session.spawnInfo.spawnedBy !== focusSummary.sessionKey) {
      return false;
    }
    if ((session.recordId || session.sessionId) === (focusSummary.recordId || focusSummary.sessionId) && session.agentId === focusSummary.agentId) {
      return false;
    }
    if (strongDescendantKeys.has(`${session.agentId}::${session.recordId || session.sessionId}`)) {
      return false;
    }
    return isWithinStrongWindow(focusSummary, session);
  });
  for (const child of extendedDescendants) {
    ensureNode(child, "extended");
    edges.push({
      from: `${focusSummary.agentId}::${focusSummary.sessionId}`,
      to: `${child.agentId}::${child.recordId || child.sessionId}`,
      type: "extended_child",
      label: child.spawnInfo?.label || null,
      via: "time_window",
    });
  }

  const siblings = [];
  if (parentView) {
    for (const child of parentView.relationships.children) {
      if (!child.resolved?.agentId || !child.resolved?.sessionId) {
        continue;
      }
      if (child.resolved.agentId === focusSummary.agentId && child.resolved.sessionId === focusSummary.sessionId) {
        continue;
      }
      ensureNode(child.resolved, "sibling");
      edges.push({
        from: `${parentView.session.agentId}::${parentView.session.sessionId}`,
        to: `${child.resolved.agentId}::${child.resolved.recordId || child.resolved.sessionId}`,
        type: "sibling_child",
        label: child.label || child.resolved.label || child.completion?.task || null,
        via: "session_transcript",
      });
      siblings.push(child.resolved);
    }
  }

  return {
    focus: {
      agentId: focusSummary.agentId,
      sessionId: focusSummary.sessionId,
      recordId: focusSummary.recordId || focusSummary.sessionId,
      sessionKey: focusSummary.sessionKey,
    },
    ancestors: parentView
      ? [
          {
            agentId: parentView.session.agentId,
            sessionId: parentView.session.sessionId,
            recordId: parentView.session.recordId || parentView.session.sessionId,
            sessionKey: parentView.session.sessionKey,
            status: parentView.session.status || null,
            updatedAt: parentView.session.updatedAt || null,
          },
        ]
      : [],
    descendants: descendants.map((session) => ({
      agentId: session.agentId,
      sessionId: session.sessionId,
      recordId: session.recordId || session.sessionId,
      sessionKey: session.sessionKey,
      status: session.status || null,
      updatedAt: session.updatedAt || null,
      label: session.label || null,
    })),
    extendedDescendants: extendedDescendants.map((session) => ({
      agentId: session.agentId,
      sessionId: session.sessionId,
      recordId: session.recordId || session.sessionId,
      sessionKey: session.sessionKey,
      status: session.status || null,
      updatedAt: session.updatedAt || null,
      startedAt: session.startedAt || null,
      label: session.spawnInfo?.label || null,
    })),
    siblings: siblings.map((session) => ({
      agentId: session.agentId,
      sessionId: session.sessionId,
      recordId: session.recordId || session.sessionId,
      sessionKey: session.sessionKey,
      status: session.status || null,
      updatedAt: session.updatedAt || null,
      label: session.label || null,
    })),
    nodes: Array.from(nodes.values()),
    edges,
  };
}

async function serveStatic(reqPath, res) {
  const normalizedPath = reqPath === "/" ? "/index.html" : reqPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, normalizedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    notFound(res);
    return;
  }
  if (!(await fileExists(filePath))) {
    notFound(res);
    return;
  }
  const ext = path.extname(filePath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[ext] || "application/octet-stream";
  const body = await fsp.readFile(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  res.end(body);
}

async function handleApi(req, res, parsedUrl) {
  if (parsedUrl.pathname === "/api/index") {
    const index = await loadIndex();
    sendJson(res, 200, index);
    return;
  }

  if (parsedUrl.pathname === "/api/session") {
    const query = parsedUrl.query || {};
    const agentId = query.agent;
    const sessionId = query.session;
    const recordId = query.record;
    if (!agentId || !sessionId) {
      sendJson(res, 400, { error: "agent and session are required" });
      return;
    }
    const currentIndex = await loadIndex();
    const view = await resolveSessionView(currentIndex, agentId, sessionId, recordId);
    if (!view) {
      sendJson(res, 404, { error: "Session file not found" });
      return;
    }
    if (view.session.spawnInfo?.spawnedBy) {
      const parentView = await findActualParentSession(currentIndex, view.session);
      if (parentView?.session?.agentId && parentView?.session?.sessionId) {
        view.relationships.parent = {
          agentId: parentView.session.agentId,
          sessionId: parentView.session.sessionId,
          recordId: parentView.session.recordId || parentView.session.sessionId,
          sessionKey: parentView.session.sessionKey,
          label: view.session.spawnInfo.label || null,
          via: "session_transcript",
        };
      }
    }
    sendJson(res, 200, view);
    return;
  }

  if (parsedUrl.pathname === "/api/chain") {
    const query = parsedUrl.query || {};
    const agentId = query.agent;
    const sessionId = query.session;
    const recordId = query.record;
    if (!agentId || !sessionId) {
      sendJson(res, 400, { error: "agent and session are required" });
      return;
    }
    const index = await loadIndex();
    const chain = await buildChain(index, agentId, sessionId, recordId);
    if (!chain) {
      sendJson(res, 404, { error: "Session chain not found" });
      return;
    }
    sendJson(res, 200, chain);
    return;
  }

  if (parsedUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      agentsDir: AGENTS_DIR,
      sessionRootsConfigPath: SESSION_ROOTS_CONFIG_PATH,
      maxCompareCount: MAX_COMPARE_COUNT,
      now: new Date().toISOString(),
    });
    return;
  }

  notFound(res);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = url.parse(req.url || "/", true);
      if ((req.method || "GET") !== "GET") {
        sendText(res, 405, "Method Not Allowed");
        return;
      }
      if (parsedUrl.pathname?.startsWith("/api/")) {
        await handleApi(req, res, parsedUrl);
        return;
      }
      await serveStatic(parsedUrl.pathname || "/", res);
    } catch (error) {
      sendJson(res, 500, {
        error: "Internal server error",
        details: String(error),
      });
    }
  });
}

function startServer() {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`OpenClaw session viewer listening on http://${HOST}:${PORT}`);
    console.log(`Reading sessions via ${SESSION_ROOTS_CONFIG_PATH}`);
  });
  return server;
}

module.exports = {
  AGENTS_DIR,
  MAX_COMPARE_COUNT,
  SESSION_ROOTS_CONFIG_PATH,
  buildSessionView,
  buildChain,
  collectSessionStats,
  createServer,
  createSessionSummary,
  loadIndex,
  findActualParentSession,
  readSessionEvents,
  resolveSessionView,
  startServer,
};

if (require.main === module) {
  startServer();
}
