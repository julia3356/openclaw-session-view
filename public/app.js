const state = {
  index: null,
  filteredSessions: [],
  selectedSessionKeys: new Set(),
  compareKeys: [],
  sessionCache: new Map(),
  syncScroll: true,
  syncScrollLock: false,
  currentChainKey: null,
  currentChainData: null,
  chainFilters: {
    query: "",
    relation: "",
    agent: "",
    status: "",
    hideSiblings: true,
  },
};

let feedbackTimer = null;

const elements = {
  sessionList: document.getElementById("session-list"),
  statsPanel: document.getElementById("stats-panel"),
  sessionRootsList: document.getElementById("session-roots-list"),
  searchInput: document.getElementById("search-input"),
  agentFilter: document.getElementById("agent-filter"),
  typeFilter: document.getElementById("type-filter"),
  statusFilter: document.getElementById("status-filter"),
  providerFilter: document.getElementById("provider-filter"),
  modelFilter: document.getElementById("model-filter"),
  createdFromFilter: document.getElementById("created-from-filter"),
  createdToFilter: document.getElementById("created-to-filter"),
  thinkingOnly: document.getElementById("thinking-only"),
  toolOnly: document.getElementById("tool-only"),
  errorOnly: document.getElementById("error-only"),
  refreshButton: document.getElementById("refresh-button"),
  compareButton: document.getElementById("compare-button"),
  chainButton: document.getElementById("chain-button"),
  clearSelectionButton: document.getElementById("clear-selection-button"),
  emptyState: document.getElementById("empty-state"),
  compareGrid: document.getElementById("compare-grid"),
  chainView: document.getElementById("chain-view"),
  actionFeedback: document.getElementById("action-feedback"),
  selectionState: document.getElementById("selection-state"),
  syncScroll: document.getElementById("sync-scroll"),
  scrollTopButton: document.getElementById("scroll-top-button"),
  quickTimeButtons: [...document.querySelectorAll(".quick-time-button")],
  sessionItemTemplate: document.getElementById("session-item-template"),
  columnTemplate: document.getElementById("column-template"),
};

function showFeedback(message, tone = "info", persist = false) {
  if (!elements.actionFeedback) {
    return;
  }
  if (feedbackTimer) {
    window.clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  elements.actionFeedback.textContent = message;
  elements.actionFeedback.classList.remove("hidden", "is-busy", "is-error");
  if (tone === "busy") {
    elements.actionFeedback.classList.add("is-busy");
  } else if (tone === "error") {
    elements.actionFeedback.classList.add("is-error");
  }
  if (!persist) {
    feedbackTimer = window.setTimeout(() => {
      elements.actionFeedback.classList.add("hidden");
      elements.actionFeedback.classList.remove("is-busy", "is-error");
    }, 2200);
  }
}

function updateScrollTopButton() {
  if (!elements.scrollTopButton) {
    return;
  }
  elements.scrollTopButton.classList.toggle("hidden", window.scrollY < 240);
}

function normalizeTimestamp(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatTime(timestamp) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized) {
    return "unknown";
  }
  const date = new Date(normalized);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function parseFilterTime(value) {
  if (!value) {
    return null;
  }
  return normalizeTimestamp(value);
}

function parseCreatedToTime(value) {
  const timestamp = parseFilterTime(value);
  if (timestamp == null) {
    return null;
  }
  // `datetime-local` is minute precision; treat the upper bound as inclusive for the whole minute.
  return timestamp + 60 * 1000 - 1;
}

function formatTimeRange(session) {
  const start = formatTime(session.startedAt);
  const end = formatTime(session.updatedAt);
  return `${start} - ${end}`;
}

function toDatetimeLocalValue(timestamp) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized) {
    return "";
  }
  const date = new Date(normalized);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function updateQuickTimeButtons() {
  const fromValue = elements.createdFromFilter.value;
  const toValue = elements.createdToFilter.value;
  const now = Date.now();
  for (const button of elements.quickTimeButtons) {
    const days = Number(button.dataset.rangeDays || 0);
    if (!days) {
      button.classList.toggle("active", !fromValue && !toValue);
      continue;
    }
    const expectedFrom = toDatetimeLocalValue(now - days * 24 * 60 * 60 * 1000);
    const expectedTo = toDatetimeLocalValue(now);
    button.classList.toggle("active", fromValue === expectedFrom && toValue === expectedTo);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stableKey(session) {
  return `${session.agentId}::${session.recordId || session.sessionId}`;
}

function sessionMatchesFilters(session) {
  const query = elements.searchInput.value.trim().toLowerCase();
  if (query) {
    const haystack = [
      session.agentId,
      session.sessionId,
      session.sessionKey,
      session.provider,
      session.model,
      session.status,
      session.summary.preview,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }

  if (elements.agentFilter.value && session.agentId !== elements.agentFilter.value) {
    return false;
  }
  if (elements.typeFilter.value && session.typeTag !== elements.typeFilter.value) {
    return false;
  }
  if (elements.statusFilter.value && session.status !== elements.statusFilter.value) {
    return false;
  }
  if (elements.providerFilter.value && session.provider !== elements.providerFilter.value) {
    return false;
  }
  if (elements.modelFilter.value && session.model !== elements.modelFilter.value) {
    return false;
  }
  const createdFrom = parseFilterTime(elements.createdFromFilter.value);
  const sessionStartedAt = normalizeTimestamp(session.startedAt);
  if (createdFrom && (!sessionStartedAt || sessionStartedAt < createdFrom)) {
    return false;
  }
  const createdTo = parseCreatedToTime(elements.createdToFilter.value);
  if (createdTo && (!sessionStartedAt || sessionStartedAt > createdTo)) {
    return false;
  }
  if (elements.thinkingOnly.checked && !session.summary.hasThinking) {
    return false;
  }
  if (elements.toolOnly.checked && !session.summary.hasToolCall) {
    return false;
  }
  if (elements.errorOnly.checked && !session.summary.hasError) {
    return false;
  }
  return true;
}

function populateSelect(select, values) {
  const current = select.value;
  while (select.options.length > 1) {
    select.remove(1);
  }
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
}

function renderStats() {
  const total = state.index?.stats.sessionCount || 0;
  const visible = state.filteredSessions.length;
  const selected = state.selectedSessionKeys.size;
  elements.statsPanel.innerHTML = `
    <div><strong>${state.index?.stats.agentCount || 0}</strong> agents</div>
    <div><strong>${total}</strong> sessions</div>
    <div><strong>${visible}</strong> visible</div>
    <div><strong>${selected}</strong> selected</div>
  `;
  elements.selectionState.textContent = `已选 ${selected} / ${state.index?.maxCompareCount || 4}`;
}

function renderSessionRoots() {
  if (!elements.sessionRootsList) {
    return;
  }
  const entries = Object.entries(state.index?.sessionRoots || {});
  elements.sessionRootsList.innerHTML = "";
  if (!entries.length) {
    elements.sessionRootsList.textContent = "未配置 session 根目录。";
    return;
  }
  for (const [agentId, rootSpec] of entries) {
    const item = document.createElement("div");
    item.className = "session-root-item";

    const title = document.createElement("div");
    title.className = "session-root-agent";
    title.textContent = agentId;

    const pathLine = document.createElement("div");
    pathLine.className = "session-root-path";
    pathLine.textContent = rootSpec?.sessionRoot || "未设置";

    const sourceLine = document.createElement("div");
    sourceLine.className = "session-root-source";
    sourceLine.textContent = rootSpec?.source === "viewer-config" ? "来源: viewer 配置" : "来源: 兼容回退";

    item.append(title, pathLine, sourceLine);
    elements.sessionRootsList.append(item);
  }
}

function flagList(session) {
  const flags = [
    session.typeTag || null,
    session.scopeTag || null,
    session.status,
    session.provider,
    session.model,
    session.summary.hasThinking ? "thinking" : null,
    session.summary.hasToolCall ? "tool" : null,
    session.summary.hasError ? "error" : null,
  ].filter(Boolean);
  return flags;
}

function archiveBadge(session) {
  if (!session.archive?.reason) {
    return { label: "当前", className: "live" };
  }
  return {
    label: session.archive.reason,
    className: `archive-${session.archive.reason}`,
  };
}

function renderSessionList() {
  elements.sessionList.innerHTML = "";
  for (const session of state.filteredSessions) {
    const key = stableKey(session);
    const fragment = elements.sessionItemTemplate.content.cloneNode(true);
    const item = fragment.querySelector(".session-item");
    const picker = fragment.querySelector(".session-picker");
    const openButton = fragment.querySelector(".session-open");
    const header = fragment.querySelector(".session-item-top");
    const meta = fragment.querySelector(".session-meta");
    const timeRange = document.createElement("div");
    timeRange.className = "session-time-range";
    const preview = fragment.querySelector(".session-preview");
    const flags = fragment.querySelector(".session-flags");

    if (state.compareKeys.includes(key)) {
      item.classList.add("active");
    }
    picker.checked = state.selectedSessionKeys.has(key);
    picker.addEventListener("change", () => toggleSelection(session));

    const badge = archiveBadge(session);
    const archivePill = document.createElement("span");
    archivePill.className = `session-state-pill ${badge.className}`;
    archivePill.textContent = badge.label;
    header.append(archivePill);

    openButton.textContent = `${session.agentId} · ${session.sessionId.slice(0, 8)}`;
    openButton.addEventListener("click", () => openCompare([key]));

    meta.textContent = `${formatTime(session.updatedAt)} · ${session.typeTag || "session"} · ${session.status || "unknown"} · ${session.chatType || "n/a"}`;
    timeRange.textContent = formatTimeRange(session);
    preview.textContent = session.summary.preview || "无文本预览";

    meta.after(timeRange);
    for (const flag of flagList(session)) {
      const chip = document.createElement("span");
      chip.className = `flag${flag === session.typeTag ? ` type-${flag}` : ""}`;
      chip.textContent = flag;
      flags.append(chip);
    }

    elements.sessionList.append(fragment);
  }
}

function applyFilters() {
  state.filteredSessions = (state.index?.sessions || [])
    .filter(sessionMatchesFilters)
    .sort((left, right) => {
      const leftTime = normalizeTimestamp(left.startedAt) || normalizeTimestamp(left.updatedAt) || 0;
      const rightTime = normalizeTimestamp(right.startedAt) || normalizeTimestamp(right.updatedAt) || 0;
      return rightTime - leftTime;
    });
  updateQuickTimeButtons();
  renderStats();
  renderSessionList();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function sessionApiUrl(basePath, session) {
  const requestUrl = new URL(basePath, window.location.origin);
  requestUrl.searchParams.set("agent", session.agentId);
  requestUrl.searchParams.set("session", session.sessionId);
  if (session.recordId) {
    requestUrl.searchParams.set("record", session.recordId);
  }
  return `${requestUrl.pathname}${requestUrl.search}`;
}

async function getChainData(key) {
  const session = findSessionByKey(key);
  if (!session) {
    throw new Error(`Unknown session: ${key}`);
  }
  return fetchJson(sessionApiUrl("/api/chain", session));
}

async function loadIndex() {
  const index = await fetchJson("/api/index");
  state.index = index;
  populateSelect(elements.agentFilter, index.filters.agents);
  populateSelect(elements.typeFilter, Array.from(new Set((index.sessions || []).map((item) => item.typeTag).filter(Boolean))).sort());
  populateSelect(elements.statusFilter, index.filters.statuses);
  populateSelect(elements.providerFilter, index.filters.providers);
  populateSelect(elements.modelFilter, index.filters.models);
  renderSessionRoots();
  applyFilters();

  const params = new URLSearchParams(window.location.search);
  const deepAgent = params.get("agent");
  const deepSession = params.get("session");
  const deepRecord = params.get("record");
  if (deepAgent && deepSession) {
    openCompare([`${deepAgent}::${deepRecord || deepSession}`]);
  }
}

function toggleSelection(session) {
  const key = stableKey(session);
  const max = state.index?.maxCompareCount || 4;
  if (state.selectedSessionKeys.has(key)) {
    state.selectedSessionKeys.delete(key);
  } else if (state.selectedSessionKeys.size < max) {
    state.selectedSessionKeys.add(key);
  } else {
    alert(`最多只能选择 ${max} 个 session`);
  }
  renderStats();
  renderSessionList();
}

function findSessionByKey(key) {
  const sessions = state.index?.sessions || [];
  const exact = sessions.find((session) => stableKey(session) === key);
  if (exact) {
    return exact;
  }
  const parts = String(key).split("::");
  if (parts.length !== 2) {
    return null;
  }
  const [agentId, sessionId] = parts;
  const candidates = sessions.filter((session) => session.agentId === agentId && session.sessionId === sessionId);
  if (!candidates.length) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  return candidates.find((session) => session.recordId === sessionId) || candidates.find((session) => !session.archive) || candidates[0];
}

function keyFromReference(reference) {
  if (!reference?.agentId || !reference?.sessionId) {
    return null;
  }
  return `${reference.agentId}::${reference.recordId || reference.sessionId}`;
}

function relationLabel(value) {
  return {
    focus: "当前",
    related: "强关联",
    extended: "扩展关联",
    sibling: "同级分支",
  }[value] || value || "未知";
}

function edgeTypeLabel(value) {
  return {
    parent_child: "主链派发",
    extended_child: "时间窗扩展",
    sibling_child: "同级派发",
  }[value] || value || "未知";
}

function uniqueKeys(keys) {
  return [...new Set(keys.filter(Boolean))];
}

async function getSessionData(key) {
  if (state.sessionCache.has(key)) {
    return state.sessionCache.get(key);
  }
  const session = findSessionByKey(key);
  if (!session) {
    throw new Error(`Unknown session: ${key}`);
  }
  const data = await fetchJson(sessionApiUrl("/api/session", session));
  state.sessionCache.set(key, data);
  return data;
}

function renderMessageMeta(item) {
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const bits = [
    item.role || item.eventType || item.kind,
    item.timestamp ? formatTime(item.timestamp) : null,
    item.model || null,
    item.provider || null,
    item.isModelApi && item.durationMs != null ? formatDuration(item.durationMs) : null,
    item.usage?.totalTokens != null ? `${formatNumber(item.usage.totalTokens)} tok` : null,
    item.toolName ? `tool=${item.toolName}` : null,
  ].filter(Boolean);
  meta.textContent = bits.join(" · ");
  return meta;
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value ?? "");
  }
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderUsageSummary(item) {
  const usage = item.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const parts = [
    usage.input != null ? `input ${formatNumber(usage.input)}` : null,
    usage.output != null ? `output ${formatNumber(usage.output)}` : null,
    usage.cacheRead != null ? `cache read ${formatNumber(usage.cacheRead)}` : null,
    usage.cacheWrite != null ? `cache write ${formatNumber(usage.cacheWrite)}` : null,
    usage.totalTokens != null ? `total ${formatNumber(usage.totalTokens)}` : null,
    usage.cost?.total != null ? `cost ${formatCost(usage.cost.total)}` : null,
  ].filter(Boolean);
  if (!parts.length && !item.durationMs) {
    return null;
  }
  const summary = document.createElement("div");
  summary.className = "usage-summary";
  const durationPart = item.isModelApi && item.durationMs != null ? [`耗时 ${formatDuration(item.durationMs)} · 推导`] : [];
  summary.textContent = [...durationPart, ...parts].join(" · ");
  return summary;
}

function attachExpandableBlock(container, contentNode, options = {}) {
  const collapsedLines = options.collapsedLines || 4;
  const kindClass = options.kindClass || "";
  container.classList.add("expandable-block");
  if (kindClass) {
    container.classList.add(kindClass);
  }
  contentNode.classList.add("expandable-content", "is-collapsed");
  contentNode.style.setProperty("--collapsed-lines", String(collapsedLines));
  container.append(contentNode);

  requestAnimationFrame(() => {
    const isOverflowing = contentNode.scrollHeight - contentNode.clientHeight > 6;
    if (!isOverflowing) {
      contentNode.classList.remove("is-collapsed");
      return;
    }
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "expand-toggle";
    toggle.textContent = "...";
    toggle.addEventListener("click", () => {
      const expanded = contentNode.classList.toggle("is-collapsed");
      toggle.textContent = expanded ? "..." : "收起";
    });
    container.append(toggle);
  });
}

function renderAssistantSegment(segment) {
  const wrapper = document.createElement("div");
  wrapper.className = `segment ${segment.type}`;

  if (segment.type === "text") {
    const text = document.createElement("div");
    text.className = "segment-text";
    text.textContent = segment.text || "";
    attachExpandableBlock(wrapper, text, { kindClass: "text-block" });
    return wrapper;
  }

  if (segment.type === "thinking") {
    wrapper.classList.add("thinking");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = segment.text ? "Thinking" : "Thinking signature only";
    details.append(summary);
    if (segment.text) {
      const pre = document.createElement("pre");
      pre.textContent = segment.text;
      details.append(pre);
    }
    if (segment.signature) {
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = typeof segment.signature === "string" ? "signature present" : "signature object present";
      details.append(meta);
      if (!segment.text) {
        const pre = document.createElement("pre");
        pre.textContent = typeof segment.signature === "string" ? segment.signature : JSON.stringify(segment.signature, null, 2);
        details.append(pre);
      }
    }
    wrapper.append(details);
    return wrapper;
  }

  if (segment.type === "tool_call") {
    const box = document.createElement("div");
    box.className = "tool-box";
    box.innerHTML = `
      <div class="tool-header">
        <strong>${escapeHtml(segment.name || "unknown")}</strong>
        <span class="mini-label">${escapeHtml(segment.toolCallId || "")}</span>
      </div>
    `;
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(segment.arguments, null, 2);
    attachExpandableBlock(box, pre, { kindClass: "code-block" });
    wrapper.append(box);
    return wrapper;
  }

  const raw = document.createElement("pre");
  raw.textContent = JSON.stringify(segment.raw || segment, null, 2);
  wrapper.append(raw);
  return wrapper;
}

function renderTimelineItem(item) {
  const article = document.createElement("article");
  article.className = `timeline-item ${item.kind === "message" ? item.role : item.kind}`;
  article.append(renderMessageMeta(item));
  const usageSummary = renderUsageSummary(item);
  if (usageSummary) {
    article.append(usageSummary);
  }

  if (item.kind === "message") {
    for (const segment of item.segments || []) {
      if (item.role === "assistant") {
        article.append(renderAssistantSegment(segment));
        continue;
      }
      const block = document.createElement("div");
      block.className = "segment";
      const text = document.createElement("div");
      text.className = "segment-text";
      text.textContent = segment.text || JSON.stringify(segment.raw || segment, null, 2);
      attachExpandableBlock(block, text, { kindClass: "text-block" });
      article.append(block);
    }
    return article;
  }

  if (item.kind === "tool_result") {
    const box = document.createElement("div");
    box.className = "tool-box";
    box.innerHTML = `
      <div class="tool-header">
        <strong>${escapeHtml(item.toolName || "toolResult")}</strong>
        <span class="${item.isError ? "error-text" : "mini-label"}">${item.isError ? "error" : "completed"}</span>
      </div>
    `;
    const pre = document.createElement("pre");
    const parts = [];
    if (item.content?.length) {
      parts.push(item.content.join("\n\n"));
    }
    if (item.details) {
      parts.push(JSON.stringify(item.details, null, 2));
    }
    pre.textContent = parts.join("\n\n");
    attachExpandableBlock(box, pre, { kindClass: "code-block" });
    article.append(box);
    return article;
  }

  const box = document.createElement("div");
  box.className = "tool-box";
  box.innerHTML = `<div class="tool-header"><strong>${escapeHtml(item.label || item.eventType)}</strong></div>`;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(item.details || item.raw || item, null, 2);
  attachExpandableBlock(box, pre, { kindClass: "code-block" });
  article.append(box);
  return article;
}

function renderRawItem(item) {
  const article = document.createElement("article");
  article.className = "timeline-item system_event";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = [item.kind, item.role || item.eventType, item.timestamp ? formatTime(item.timestamp) : null]
    .filter(Boolean)
    .join(" · ");
  article.append(meta);

  const block = document.createElement("div");
  block.className = "raw-block";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "查看原始事件";
  details.append(summary);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(item.raw || item, null, 2);
  details.append(pre);
  block.append(details);
  article.append(block);
  return article;
}

function getVisibleCompareTimelines() {
  return [...elements.compareGrid.querySelectorAll(".timeline")]
    .filter((timeline) => !timeline.classList.contains("hidden"));
}

function syncColumnScroll(source) {
  if (!state.syncScroll || state.syncScrollLock) {
    return;
  }
  const timelines = getVisibleCompareTimelines();
  if (timelines.length < 2) {
    return;
  }
  const maxScroll = source.scrollHeight - source.clientHeight;
  const ratio = maxScroll > 0 ? source.scrollTop / maxScroll : 0;
  state.syncScrollLock = true;
  try {
    for (const timeline of timelines) {
      if (timeline === source) {
        continue;
      }
      const targetMax = timeline.scrollHeight - timeline.clientHeight;
      timeline.scrollTop = targetMax > 0 ? ratio * targetMax : 0;
    }
  } finally {
    requestAnimationFrame(() => {
      state.syncScrollLock = false;
    });
  }
}

function renderColumn(data, key) {
  const fragment = elements.columnTemplate.content.cloneNode(true);
  const column = fragment.querySelector(".compare-column");
  const title = fragment.querySelector(".column-title");
  const subtitle = fragment.querySelector(".column-subtitle");
  const summary = fragment.querySelector(".column-summary");
  const chatView = fragment.querySelector(".chat-view");
  const rawView = fragment.querySelector(".raw-view");
  const rawToggle = fragment.querySelector(".raw-toggle");
  const closeButton = fragment.querySelector(".close-column");

  title.textContent = `${data.session.agentId} · ${data.session.sessionId}`;
  subtitle.textContent = `${formatTime(data.session.updatedAt)} · ${data.session.provider || "unknown"} · ${data.session.model || "unknown"}`;
  summary.innerHTML = `
    <div><strong>Status:</strong> ${escapeHtml(data.session.status || "unknown")}</div>
    <div><strong>Origin:</strong> ${escapeHtml(data.session.originProvider || "n/a")} / ${escapeHtml(data.session.originSurface || "n/a")}</div>
    <div><strong>Workspace:</strong> ${escapeHtml(data.session.workspaceDir || data.session.sessionMeta?.cwd || "n/a")}</div>
    <div><strong>Preview:</strong> ${escapeHtml(data.session.summary.preview || "n/a")}</div>
  `;

  appendRelationshipSummary(summary, data, key);

  for (const item of data.timeline) {
    chatView.append(renderTimelineItem(item));
    rawView.append(renderRawItem(item));
  }

  const onChatScroll = () => syncColumnScroll(chatView);
  const onRawScroll = () => syncColumnScroll(rawView);
  chatView.addEventListener("scroll", onChatScroll);
  rawView.addEventListener("scroll", onRawScroll);
  rawToggle.addEventListener("click", () => {
    const rawVisible = !rawView.classList.contains("hidden");
    rawView.classList.toggle("hidden", rawVisible);
    chatView.classList.toggle("hidden", !rawVisible);
    rawToggle.textContent = rawVisible ? "显示 Raw" : "显示 Chat";
    const visibleTimeline = rawVisible ? chatView : rawView;
    syncColumnScroll(visibleTimeline);
  });
  closeButton.addEventListener("click", () => {
    state.compareKeys = state.compareKeys.filter((candidate) => candidate !== key);
    renderCompare();
    renderSessionList();
  });

  return column;
}

function appendRelationshipSummary(container, data, currentKey) {
  const relationships = data.relationships || {};
  const children = relationships.children || [];
  const parent = relationships.parent || null;
  const completions = relationships.childCompletions || [];

  if (parent) {
    container.append(renderRelationBlock("Parent", [
      {
        title: parent.sessionId ? `${parent.agentId} · ${parent.sessionId}` : parent.sessionKey,
        meta: [parent.label, parent.via].filter(Boolean).join(" · "),
        reference: parent,
        currentKey,
      },
    ]));
  }

  if (children.length) {
    container.append(
      renderRelationBlock(
        `Spawned Children (${children.length})`,
        children.map((child) => ({
          title:
            child.resolved?.sessionId
              ? `${child.resolved.agentId} · ${child.resolved.sessionId}`
              : child.accepted?.childSessionKey || child.requestedAgentId || "unknown child",
          meta: [
            child.label || child.resolved?.label || null,
            child.resolved?.status || child.completion?.status || child.accepted?.status || null,
            child.accepted?.runId ? `run ${child.accepted.runId.slice(0, 8)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          reference: child.resolved || null,
          currentKey,
        }))
      )
    );
  }

  if (completions.length) {
    container.append(
      renderRelationBlock(
        `Completion Events (${completions.length})`,
        completions.map((completion) => ({
          title:
            completion.resolved?.sessionId
              ? `${completion.resolved.agentId} · ${completion.resolved.sessionId}`
              : completion.sessionKey || completion.sessionId || "completion",
          meta: [completion.task, completion.status, completion.timestamp ? formatTime(completion.timestamp) : null]
            .filter(Boolean)
            .join(" · "),
          reference: completion.resolved || null,
          currentKey,
        }))
      )
    );
  }
}

function renderRelationBlock(titleText, items) {
  const block = document.createElement("div");
  block.className = "relation-block";
  const title = document.createElement("div");
  title.className = "relation-title";
  title.textContent = titleText;
  block.append(title);

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "relation-item";
    const line = document.createElement("div");
    line.className = "relation-line";

    const strong = document.createElement("strong");
    strong.textContent = item.title;
    line.append(strong);

    if (item.meta) {
      const meta = document.createElement("span");
      meta.className = "mini-label";
      meta.textContent = item.meta;
      line.append(meta);
    }
    row.append(line);

    const linkedKey = keyFromReference(item.reference);
    if (linkedKey && linkedKey !== item.currentKey) {
      const actions = document.createElement("div");
      actions.className = "relation-actions";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.textContent = "打开";
      openButton.addEventListener("click", () => openCompare([linkedKey]));
      actions.append(openButton);

      const compareButton = document.createElement("button");
      compareButton.type = "button";
      compareButton.textContent = "并排";
      compareButton.addEventListener("click", () => {
        openComparePair(item.currentKey, linkedKey);
      });
      actions.append(compareButton);

      row.append(actions);
    }

    block.append(row);
  }

  return block;
}

async function renderCompare() {
  elements.compareGrid.innerHTML = "";
  elements.chainView.classList.add("hidden");
  elements.chainView.innerHTML = "";
  state.currentChainKey = null;
  state.currentChainData = null;
  if (!state.compareKeys.length) {
    elements.compareGrid.classList.add("hidden");
    elements.emptyState.classList.remove("hidden");
    renderStats();
    return;
  }

  elements.emptyState.classList.add("hidden");
  elements.compareGrid.classList.remove("hidden");
  elements.compareGrid.className = `compare-grid columns-${state.compareKeys.length}`;
  elements.compareGrid.style.setProperty("--compare-count", String(state.compareKeys.length));

  for (const key of state.compareKeys) {
    try {
      const data = await getSessionData(key);
      elements.compareGrid.append(renderColumn(data, key));
    } catch (error) {
      const errorCard = document.createElement("article");
      errorCard.className = "timeline-item system_event";
      errorCard.innerHTML = `<div class="error-text">加载失败: ${escapeHtml(String(error.message || error))}</div>`;
      elements.compareGrid.append(errorCard);
    }
  }
  renderStats();
}

function chainNodeMatchesFilters(node) {
  const filters = state.chainFilters;
  if (filters.hideSiblings && node.relation === "sibling") {
    return false;
  }
  if (filters.relation && node.relation !== filters.relation) {
    return false;
  }
  if (filters.agent && node.agentId !== filters.agent) {
    return false;
  }
  if (filters.status && (node.status || "") !== filters.status) {
    return false;
  }
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [node.agentId, node.sessionId, node.sessionKey, node.label, node.status, node.relation]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  return true;
}

function getFilteredChain(chain) {
  const nodes = chain.nodes.filter(chainNodeMatchesFilters);
  const allowed = new Set(nodes.map((node) => node.key));
  const edges = chain.edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to));
  return { nodes, edges };
}

function buildChainFilterPanel(chain) {
  const wrapper = document.createElement("div");
  wrapper.className = "chain-filters";

  const relations = Array.from(new Set(chain.nodes.map((node) => node.relation).filter(Boolean))).sort();
  const agents = Array.from(new Set(chain.nodes.map((node) => node.agentId).filter(Boolean))).sort();
  const statuses = Array.from(new Set(chain.nodes.map((node) => node.status).filter(Boolean))).sort();

  const queryField = document.createElement("label");
  queryField.className = "field";
  queryField.innerHTML = `<span>关键词</span><input type="search" placeholder="agent / session / label / status">`;
  queryField.querySelector("input").value = state.chainFilters.query;
  queryField.querySelector("input").addEventListener("input", (event) => {
    state.chainFilters.query = event.target.value;
    rerenderCurrentChain();
  });
  wrapper.append(queryField);

  const relationField = document.createElement("label");
  relationField.className = "field";
  relationField.innerHTML = `<span>关系</span>`;
  const relationSelect = document.createElement("select");
  relationSelect.innerHTML = `<option value="">全部关系</option>${relations.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(relationLabel(value))}</option>`).join("")}`;
  relationSelect.value = state.chainFilters.relation;
  relationSelect.addEventListener("change", (event) => {
    state.chainFilters.relation = event.target.value;
    rerenderCurrentChain();
  });
  relationField.append(relationSelect);
  wrapper.append(relationField);

  const agentField = document.createElement("label");
  agentField.className = "field";
  agentField.innerHTML = `<span>Agent</span>`;
  const agentSelect = document.createElement("select");
  agentSelect.innerHTML = `<option value="">全部 Agent</option>${agents.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  agentSelect.value = state.chainFilters.agent;
  agentSelect.addEventListener("change", (event) => {
    state.chainFilters.agent = event.target.value;
    rerenderCurrentChain();
  });
  agentField.append(agentSelect);
  wrapper.append(agentField);

  const statusField = document.createElement("label");
  statusField.className = "field";
  statusField.innerHTML = `<span>Status</span>`;
  const statusSelect = document.createElement("select");
  statusSelect.innerHTML = `<option value="">全部状态</option>${statuses.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  statusSelect.value = state.chainFilters.status;
  statusSelect.addEventListener("change", (event) => {
    state.chainFilters.status = event.target.value;
    rerenderCurrentChain();
  });
  statusField.append(statusSelect);
  wrapper.append(statusField);

  const toggleWrap = document.createElement("div");
  toggleWrap.className = "field";
  toggleWrap.innerHTML = `<span>快捷</span>`;
  const toggleRow = document.createElement("div");
  toggleRow.className = "chain-filter-toggles";

  const hideSiblings = document.createElement("label");
  hideSiblings.innerHTML = `<input type="checkbox"> 隐藏 sibling`;
  hideSiblings.querySelector("input").checked = state.chainFilters.hideSiblings;
  hideSiblings.querySelector("input").addEventListener("change", (event) => {
    state.chainFilters.hideSiblings = event.target.checked;
    rerenderCurrentChain();
  });
  toggleRow.append(hideSiblings);

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.textContent = "重置筛选";
  resetButton.addEventListener("click", () => {
    state.chainFilters = {
      query: "",
      relation: "",
      agent: "",
      status: "",
      hideSiblings: true,
    };
    rerenderCurrentChain();
  });
  toggleRow.append(resetButton);

  toggleWrap.append(toggleRow);
  wrapper.append(toggleWrap);

  return wrapper;
}

function renderChainNode(node) {
  const card = document.createElement("article");
  card.className = `chain-node ${node.relation || "related"}`;

  const title = document.createElement("div");
  title.className = "chain-node-title";
  title.textContent = `${node.agentId} · ${node.sessionId}`;
  card.append(title);

  const meta = document.createElement("div");
  meta.className = "chain-node-meta";
  meta.innerHTML = [
    node.relation ? `关系: ${escapeHtml(relationLabel(node.relation))}` : null,
    node.label ? `label: ${escapeHtml(node.label)}` : null,
    node.status ? `status: ${escapeHtml(node.status)}` : null,
    node.updatedAt ? `updated: ${escapeHtml(formatTime(node.updatedAt))}` : null,
    node.sessionKey ? `key: ${escapeHtml(node.sessionKey)}` : null,
  ]
    .filter(Boolean)
    .join("<br>");
  card.append(meta);

  const key = `${node.agentId}::${node.sessionId}`;
  const actions = document.createElement("div");
  actions.className = "chain-actions";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.textContent = "打开";
  openButton.addEventListener("click", () => openCompare([key]));
  actions.append(openButton);

  const compareButton = document.createElement("button");
  compareButton.type = "button";
  compareButton.textContent = "并排";
  compareButton.addEventListener("click", () => {
    openComparePair(state.currentChainKey || state.compareKeys[0] || null, key);
  });
  actions.append(compareButton);

  const chainButton = document.createElement("button");
  chainButton.type = "button";
  chainButton.textContent = "查看链";
  chainButton.addEventListener("click", () => openChain(key));
  actions.append(chainButton);

  card.append(actions);
  return card;
}

async function renderChain(key) {
  elements.compareGrid.classList.add("hidden");
  elements.compareGrid.innerHTML = "";
  elements.emptyState.classList.add("hidden");
  elements.chainView.classList.remove("hidden");
  elements.chainView.innerHTML = "";

  const chain = await getChainData(key);
  state.currentChainKey = key;
  state.currentChainData = chain;
  const filtered = getFilteredChain(chain);
  const focusPanel = document.createElement("section");
  focusPanel.className = "chain-panel";
  focusPanel.innerHTML = `<h2>调用链视图</h2><div class="chain-node-meta">双层显示：强关联只认当前 transcript 里的直证；扩展关联只保留当前主 session 开始后、结束前才创建的 subagent session。</div>`;
  focusPanel.append(buildChainFilterPanel(chain));
  const stats = document.createElement("div");
  stats.className = "chain-node-meta";
  stats.style.marginTop = "12px";
  stats.textContent = `当前显示 ${filtered.nodes.length} / ${chain.nodes.length} 个 nodes，${filtered.edges.length} / ${chain.edges.length} 条 edges`;
  focusPanel.append(stats);
  const layerStats = document.createElement("div");
  layerStats.className = "chain-node-meta";
  layerStats.style.marginTop = "8px";
  layerStats.textContent = `强关联 ${chain.descendants.length} 个，扩展关联 ${chain.extendedDescendants?.length || 0} 个`;
  focusPanel.append(layerStats);
  elements.chainView.append(focusPanel);

  const nodesPanel = document.createElement("section");
  nodesPanel.className = "chain-panel";
  nodesPanel.innerHTML = `<div class="relation-title">Nodes</div>`;
  const nodeGrid = document.createElement("div");
  nodeGrid.className = "chain-grid";
  for (const node of filtered.nodes) {
    nodeGrid.append(renderChainNode(node));
  }
  nodesPanel.append(nodeGrid);
  elements.chainView.append(nodesPanel);

  const edgesPanel = document.createElement("section");
  edgesPanel.className = "chain-panel";
  edgesPanel.innerHTML = `<div class="relation-title">Edges</div>`;
  const edgeList = document.createElement("div");
  edgeList.className = "chain-edge-list";
  for (const edge of filtered.edges) {
    const row = document.createElement("div");
    row.className = "chain-edge";
    const fromNode = filtered.nodes.find((node) => node.key === edge.from) || chain.nodes.find((node) => node.key === edge.from);
    const toNode = filtered.nodes.find((node) => node.key === edge.to) || chain.nodes.find((node) => node.key === edge.to);
    row.textContent = `${fromNode?.agentId || edge.from} / ${fromNode?.sessionId || ""} -> ${toNode?.agentId || edge.to} / ${toNode?.sessionId || ""} · ${edgeTypeLabel(edge.type)}${edge.label ? ` · ${edge.label}` : ""}`;
    edgeList.append(row);
  }
  edgesPanel.append(edgeList);
  elements.chainView.append(edgesPanel);
}

function rerenderCurrentChain() {
  if (!state.currentChainKey) {
    return;
  }
  renderChain(state.currentChainKey).catch((error) => {
    elements.chainView.classList.remove("hidden");
    elements.chainView.innerHTML = `<section class="chain-panel"><div class="error-text">加载调用链失败: ${escapeHtml(String(error.message || error))}</div></section>`;
  });
}

function openChain(key) {
  state.compareKeys = [key];
  updateUrl([key]);
  renderSessionList();
  renderStats();
  renderChain(key).catch((error) => {
    elements.chainView.classList.remove("hidden");
    elements.chainView.innerHTML = `<section class="chain-panel"><div class="error-text">加载调用链失败: ${escapeHtml(String(error.message || error))}</div></section>`;
  });
}

function updateUrl(keys) {
  const url = new URL(window.location.href);
  if (keys.length === 1) {
    const session = findSessionByKey(keys[0]);
    url.searchParams.set("agent", session.agentId);
    url.searchParams.set("session", session.sessionId);
    if (session.recordId) {
      url.searchParams.set("record", session.recordId);
    } else {
      url.searchParams.delete("record");
    }
  } else {
    url.searchParams.delete("agent");
    url.searchParams.delete("session");
    url.searchParams.delete("record");
  }
  window.history.replaceState({}, "", url);
}

function openCompare(keys) {
  state.compareKeys = uniqueKeys(keys).slice(0, state.index?.maxCompareCount || 4);
  updateUrl(state.compareKeys);
  renderCompare();
  renderSessionList();
}

function openComparePair(primaryKey, secondaryKey) {
  const merged = uniqueKeys([
    primaryKey,
    secondaryKey,
    ...state.compareKeys,
  ]).slice(0, state.index?.maxCompareCount || 4);
  if (!merged.length) {
    return;
  }
  openCompare(merged);
}

function openSelectedCompare() {
  const keys = [...state.selectedSessionKeys];
  if (!keys.length) {
    return;
  }
  openCompare(keys);
}

function pruneSelectionState() {
  const validKeys = new Set((state.index?.sessions || []).map((session) => stableKey(session)));
  state.selectedSessionKeys = new Set(
    [...state.selectedSessionKeys].filter((key) => validKeys.has(key))
  );
  state.compareKeys = state.compareKeys.filter((key) => validKeys.has(key));
  if (state.currentChainKey && !validKeys.has(state.currentChainKey)) {
    state.currentChainKey = null;
    state.currentChainData = null;
    elements.chainView.classList.add("hidden");
    elements.chainView.innerHTML = "";
  }
}

async function refreshData() {
  const previousCompareKeys = [...state.compareKeys];
  const previousChainKey = state.currentChainKey;
  state.sessionCache.clear();
  showFeedback("正在刷新 session 列表…", "busy", true);
  await loadIndex();
  pruneSelectionState();
  if (previousCompareKeys.length) {
    const refreshedCompareKeys = previousCompareKeys.filter((key) => findSessionByKey(key));
    if (refreshedCompareKeys.length) {
      openCompare(refreshedCompareKeys);
    } else {
      renderCompare();
      renderSessionList();
    }
  } else {
    renderCompare();
    renderSessionList();
  }
  if (previousChainKey && findSessionByKey(previousChainKey)) {
    await renderChain(previousChainKey);
  } else if (!state.compareKeys.length) {
    elements.emptyState.classList.remove("hidden");
  }
  showFeedback(`刷新完成，可见 ${state.filteredSessions.length} 条 session`);
}

function bindEvents() {
  const filterInputs = [
    elements.searchInput,
    elements.agentFilter,
    elements.typeFilter,
    elements.statusFilter,
    elements.providerFilter,
    elements.modelFilter,
    elements.createdFromFilter,
    elements.createdToFilter,
    elements.thinkingOnly,
    elements.toolOnly,
    elements.errorOnly,
  ];
  for (const input of filterInputs) {
    input.addEventListener("input", applyFilters);
    input.addEventListener("change", applyFilters);
  }
  for (const button of elements.quickTimeButtons) {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.rangeDays || 0);
      if (!days) {
        elements.createdFromFilter.value = "";
        elements.createdToFilter.value = "";
        applyFilters();
        showFeedback("已清空时间筛选");
        return;
      }
      const now = Date.now();
      elements.createdFromFilter.value = toDatetimeLocalValue(now - days * 24 * 60 * 60 * 1000);
      elements.createdToFilter.value = toDatetimeLocalValue(now);
      applyFilters();
      showFeedback(`已筛选最近 ${days} 天，共 ${state.filteredSessions.length} 条`);
    });
  }
  elements.refreshButton.addEventListener("click", async () => {
    await refreshData();
  });
  elements.compareButton.addEventListener("click", openSelectedCompare);
  elements.chainButton.addEventListener("click", () => {
    const keys = [...state.selectedSessionKeys];
    if (keys.length === 1) {
      openChain(keys[0]);
      return;
    }
    if (!keys.length && state.compareKeys.length === 1) {
      openChain(state.compareKeys[0]);
      return;
    }
    alert("调用链视图一次只支持打开 1 个 session。请先只选择一个。");
  });
  elements.clearSelectionButton.addEventListener("click", () => {
    state.selectedSessionKeys.clear();
    renderStats();
    renderSessionList();
    elements.chainView.classList.add("hidden");
    elements.chainView.innerHTML = "";
    state.currentChainKey = null;
    state.currentChainData = null;
    showFeedback("已清空当前选择");
  });
  elements.syncScroll.addEventListener("change", () => {
    state.syncScroll = elements.syncScroll.checked;
    showFeedback(state.syncScroll ? "已开启同步滚动" : "已关闭同步滚动");
  });
  elements.scrollTopButton.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    showFeedback("已回到顶部");
  });
  window.addEventListener("scroll", updateScrollTopButton, { passive: true });
}

async function main() {
  bindEvents();
  await loadIndex();
  updateScrollTopButton();
}

main().catch((error) => {
  elements.emptyState.classList.remove("hidden");
  elements.emptyState.innerHTML = `<h2>加载失败</h2><p>${escapeHtml(String(error.message || error))}</p>`;
});
