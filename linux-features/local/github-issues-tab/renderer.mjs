function operationState(overrides = {}) {
  return {
    requestId: null,
    status: "idle",
    error: null,
    warnings: [],
    ...overrides,
  };
}

function pageState() {
  return { hasNextPage: false, endCursor: null };
}

export function initialIssuesState() {
  return {
    host: null,
    viewerLogin: null,
    view: "assigned",
    stateFilter: "open",
    repository: "",
    text: "",
    list: operationState({ items: [], pageInfo: pageState(), rateLimit: null, append: false }),
    listPage: pageState(),
    selectedId: null,
    detail: operationState({ issue: null, rateLimit: null }),
    timeline: operationState({ items: [], pageInfo: pageState(), rateLimit: null, append: false }),
    capabilities: operationState({ rateLimit: null }),
  };
}

function errorValue(error) {
  if (error == null) return null;
  if (typeof error === "string") return { code: "adapter-failed", message: error };
  return {
    code: typeof error.code === "string" ? error.code : "adapter-failed",
    message: typeof error.message === "string" ? error.message : "GitHub Issues request failed",
  };
}

function warningsValue(value) {
  return Array.isArray(value) ? value.filter((warning) => warning != null) : [];
}

function isCurrent(operation, requestId) {
  return operation.requestId === requestId;
}

function issueId(issue) {
  return issue && typeof issue.id === "string" && issue.id.length > 0 ? issue.id : null;
}

function normalizeIssues(issues) {
  const seen = new Set();
  return (Array.isArray(issues) ? issues : []).filter((issue) => {
    const id = issueId(issue);
    if (id === null || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function hasWarnings(data) {
  return Array.isArray(data?.warnings) && data.warnings.length > 0;
}

function statusFor(data, fallback = "ready") {
  return hasWarnings(data) ? "partial" : fallback;
}

function resetDataForHost(state, host) {
  return {
    ...initialIssuesState(),
    host: host ?? null,
    view: state.view,
    stateFilter: state.stateFilter,
    repository: state.repository,
    text: state.text,
  };
}

function clearListForFilter(state) {
  return {
    ...state,
    list: operationState({ items: [], pageInfo: pageState(), rateLimit: state.list.rateLimit, append: false }),
    listPage: pageState(),
    selectedId: null,
    detail: operationState({ issue: null, rateLimit: null }),
    timeline: operationState({ items: [], pageInfo: pageState(), rateLimit: null, append: false }),
  };
}

export function issuesReducer(state, action) {
  if (!state || !action || typeof action.type !== "string") return state;
  switch (action.type) {
    case "host-set":
      if (state.host === (action.host ?? null)) return state;
      return resetDataForHost(state, action.host);
    case "filters-set":
    case "filter-change": {
      const next = {
        ...clearListForFilter(state),
        view: ["assigned", "authored", "all"].includes(action.view) ? action.view : state.view,
        stateFilter: ["open", "closed", "all"].includes(action.stateFilter) ? action.stateFilter : state.stateFilter,
        repository: typeof action.repository === "string" ? action.repository : state.repository,
        text: typeof action.text === "string" ? action.text : state.text,
      };
      return next;
    }
    case "view-set":
    case "set-view":
      return ["assigned", "authored", "all"].includes(action.view) ? { ...clearListForFilter(state), view: action.view } : state;
    case "state-set":
    case "set-state":
      return ["open", "closed", "all"].includes(action.stateFilter) ? { ...clearListForFilter(state), stateFilter: action.stateFilter } : state;
    case "repository-set":
    case "set-repository":
      return typeof action.repository === "string" ? { ...clearListForFilter(state), repository: action.repository } : state;
    case "text-set":
    case "set-text":
      return typeof action.text === "string" ? { ...clearListForFilter(state), text: action.text } : state;
    case "capabilities-start":
      return {
        ...state,
        capabilities: operationState({ ...state.capabilities, requestId: action.requestId, status: "loading", error: null, warnings: [] }),
      };
    case "capabilities-success":
      if (!isCurrent(state.capabilities, action.requestId)) return state;
      if (typeof action.data?.host === "string" && action.data.host !== state.host) {
        const reset = resetDataForHost(state, action.data.host);
        return {
          ...reset,
          viewerLogin: typeof action.data.viewerLogin === "string" ? action.data.viewerLogin : null,
          capabilities: {
            ...reset.capabilities,
            requestId: action.requestId,
            status: statusFor(action.data),
            error: null,
            warnings: warningsValue(action.data?.warnings),
            rateLimit: action.data?.rateLimit ?? null,
          },
        };
      }
      return {
        ...state,
        host: typeof action.data?.host === "string" ? action.data.host : state.host,
        viewerLogin: typeof action.data?.viewerLogin === "string" ? action.data.viewerLogin : state.viewerLogin,
        capabilities: {
          ...state.capabilities,
          status: statusFor(action.data),
          error: null,
          warnings: warningsValue(action.data?.warnings),
          rateLimit: action.data?.rateLimit ?? null,
        },
      };
    case "capabilities-error":
      if (!isCurrent(state.capabilities, action.requestId)) return state;
      return { ...state, capabilities: { ...state.capabilities, status: "error", error: errorValue(action.error), warnings: warningsValue(action.warnings) } };
    case "list-start":
      return {
        ...state,
        list: {
          ...state.list,
          requestId: action.requestId,
          status: action.append ? "refreshing" : "loading",
          append: action.append === true,
          error: null,
          warnings: [],
          ...(action.append ? {} : { items: [], pageInfo: pageState() }),
        },
        listPage: action.append ? state.listPage : pageState(),
      };
    case "list-success": {
      if (!isCurrent(state.list, action.requestId)) return state;
      if (typeof action.data?.host === "string" && state.host !== null && action.data.host !== state.host) return state;
      const incoming = normalizeIssues(action.data?.issues);
      const append = action.append === true || action.data?.append === true || state.list.append === true;
      const items = append ? mergeIssues(state.list.items, incoming) : incoming;
      const selectedStillPresent = state.selectedId === null || items.some((issue) => issue.id === state.selectedId);
      return {
        ...state,
        host: typeof action.data?.host === "string" ? action.data.host : state.host,
        viewerLogin: typeof action.data?.viewerLogin === "string" ? action.data.viewerLogin : state.viewerLogin,
        selectedId: selectedStillPresent ? state.selectedId : null,
        detail: selectedStillPresent ? state.detail : operationState({ issue: null }),
        timeline: selectedStillPresent ? state.timeline : operationState({ items: [], pageInfo: pageState(), rateLimit: null, append: false }),
        list: {
          ...state.list,
          status: statusFor(action.data),
          error: null,
          warnings: warningsValue(action.data?.warnings),
          items,
          pageInfo: action.data?.pageInfo ?? pageState(),
          rateLimit: action.data?.rateLimit ?? null,
          append: false,
        },
        listPage: action.data?.pageInfo ?? pageState(),
      };
    }
    case "list-error":
      if (!isCurrent(state.list, action.requestId)) return state;
      return { ...state, list: { ...state.list, status: "error", error: errorValue(action.error), warnings: warningsValue(action.warnings) } };
    case "select": {
      const selectedId = typeof action.issueId === "string" ? action.issueId : null;
      if (selectedId === state.selectedId && !action.requestId) return state;
      return {
        ...state,
        selectedId,
        detail: selectedId === null
          ? operationState({ issue: null })
          : operationState({ ...state.detail, requestId: action.requestId ?? state.detail.requestId, status: "loading", error: null, warnings: [] }),
        timeline: selectedId === null ? operationState({ items: [], pageInfo: pageState(), rateLimit: null }) : state.timeline,
      };
    }
    case "detail-start":
      return { ...state, detail: { ...state.detail, requestId: action.requestId, status: "loading", error: null, warnings: [] }, timeline: action.resetTimeline === false ? state.timeline : operationState({ items: [], pageInfo: pageState(), rateLimit: null }) };
    case "detail-success": {
      if (!isCurrent(state.detail, action.requestId)) return state;
      const data = action.data ?? {};
      const timeline = data.timeline ?? {};
      const timelineWarnings = [...warningsValue(data.warnings), ...warningsValue(timeline.warnings)];
      return {
        ...state,
        detail: { ...state.detail, status: statusFor(data), error: null, warnings: warningsValue(data.warnings), issue: data.issue ?? null, rateLimit: data.rateLimit ?? null },
        timeline: {
          ...state.timeline,
          requestId: state.timeline.requestId,
          status: timelineWarnings.length > 0 ? "partial" : "ready",
          error: null,
          warnings: warningsValue(timelineWarnings),
          items: mergeTimeline([], timeline.items),
          pageInfo: timeline.pageInfo ?? pageState(),
          rateLimit: data.rateLimit ?? null,
        },
      };
    }
    case "detail-error":
      if (!isCurrent(state.detail, action.requestId)) return state;
      return { ...state, detail: { ...state.detail, status: "error", error: errorValue(action.error), warnings: warningsValue(action.warnings) } };
    case "timeline-start":
      return { ...state, timeline: { ...state.timeline, requestId: action.requestId, status: action.append ? "refreshing" : "loading", error: null, warnings: [] } };
    case "timeline-success": {
      if (!isCurrent(state.timeline, action.requestId)) return state;
      const data = action.data ?? {};
      const incoming = data.items ?? data.timeline?.items ?? [];
      const append = action.append === true || data.append === true || state.timeline.append === true;
      return {
        ...state,
        timeline: {
          ...state.timeline,
          status: statusFor(data),
          error: null,
          warnings: warningsValue(data.warnings),
          items: append ? mergeTimeline(state.timeline.items, incoming) : mergeTimeline([], incoming),
          pageInfo: data.pageInfo ?? data.timeline?.pageInfo ?? pageState(),
          rateLimit: data.rateLimit ?? state.timeline.rateLimit,
          append: false,
        },
      };
    }
    case "timeline-error":
      if (!isCurrent(state.timeline, action.requestId)) return state;
      return { ...state, timeline: { ...state.timeline, status: "error", error: errorValue(action.error), warnings: warningsValue(action.warnings) } };
    default:
      return state;
  }
}

function mergeIssues(existing, incoming) {
  const result = [];
  const seen = new Set();
  for (const issue of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const id = issueId(issue);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    result.push(issue);
  }
  return result;
}

function timelineKey(item, index) {
  if (item && typeof item.id === "string" && item.id.length > 0) return `id:${item.id}`;
  if (!item || typeof item !== "object") return `index:${index}`;
  return [item.kind, item.type, item.createdAt, item.actor?.login, item.body].map((value) => value ?? "").join("|");
}

export function mergeTimeline(existing, incoming) {
  const values = [];
  const seen = new Set();
  for (const [index, item] of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])].entries()) {
    const key = timelineKey(item, index);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(item);
  }
  return values
    .map((item, index) => ({ item, index, timestamp: Date.parse(item?.createdAt ?? "") }))
    .sort((left, right) => {
      const leftTime = Number.isNaN(left.timestamp) ? Number.POSITIVE_INFINITY : left.timestamp;
      const rightTime = Number.isNaN(right.timestamp) ? Number.POSITIVE_INFINITY : right.timestamp;
      return leftTime - rightTime || left.index - right.index;
    })
    .map(({ item }) => item);
}

function randomRequestId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`.slice(0, 96);
}

function bridge() {
  return typeof window !== "undefined" ? window.electronBridge?.githubIssues : null;
}

function safeError(error) {
  return error && typeof error === "object" ? error : { code: "adapter-failed", message: "GitHub Issues request failed" };
}

function formatRelative(value) {
  if (!value) return "—";
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function display(value, fallback = "—") {
  return value == null || value === "" ? fallback : String(value);
}

function safeHost(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 253
    && value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
    ? value
    : null;
}

function safePathPart(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u.test(value) ? value : null;
}

function repositoryUrl(host, repository) {
  const validHost = safeHost(host);
  const parts = typeof repository === "string" ? repository.split("/") : [];
  if (!validHost || parts.length !== 2 || !safePathPart(parts[0]) || !safePathPart(parts[1])) return null;
  return `https://${validHost}/${parts[0]}/${parts[1]}`;
}

function userUrl(host, login) {
  const validHost = safeHost(host);
  if (!validHost || !safePathPart(login)) return null;
  return `https://${validHost}/${login}`;
}

function commitUrl(host, repository, oid) {
  const base = repositoryUrl(host, repository);
  if (!base || typeof oid !== "string" || !/^[A-Fa-f0-9]{7,64}$/u.test(oid)) return null;
  return `${base}/commit/${oid}`;
}

function rateLimitText(rateLimit) {
  if (!rateLimit || (rateLimit.cost == null && rateLimit.remaining == null && !rateLimit.resetAt)) return null;
  const parts = [];
  if (rateLimit.cost != null) parts.push(`cost ${rateLimit.cost}`);
  if (rateLimit.remaining != null) parts.push(`${rateLimit.remaining} remaining`);
  if (rateLimit.resetAt) parts.push(`resets ${rateLimit.resetAt}`);
  return `Rate limit: ${parts.join(" · ")}`;
}

export function bridgeResponseStatus(response, requestId) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return "invalid";
  if (typeof response.requestId !== "string" || typeof response.ok !== "boolean") return "invalid";
  if (response.requestId !== requestId) return "stale";
  return "current";
}

function labelColor(value) {
  return typeof value === "string" && /^[A-Fa-f0-9]{6}$/u.test(value) ? `#${value}` : null;
}

function labelNodes(React, labels) {
  return (Array.isArray(labels) ? labels : []).map((label, index) => node(React, "span", {
    key: `${label?.name || "label"}-${index}`,
    title: label?.description || undefined,
    style: {
      display: "inline-block",
      border: `1px solid ${labelColor(label?.color) || "var(--color-token-border-light, currentColor)"}`,
      borderRadius: "999px",
      padding: "1px 6px",
      marginRight: "4px",
    },
  }, display(label?.name)));
}

function milestoneText(milestone) {
  if (!milestone?.title) return null;
  const details = [
    milestone.number != null ? `#${milestone.number}` : null,
    milestone.state,
    milestone.dueOn ? `due ${milestone.dueOn}` : null,
  ].filter(Boolean);
  return `Milestone: ${milestone.title}${details.length ? ` (${details.join(" · ")})` : ""}`;
}

function timelineEventText(React, item, host, openExternal) {
  const actor = item.actor?.login || "Someone";
  const actorUrl = userUrl(host, item.actor?.login);
  const actorNode = actorUrl ? Link({ React, url: actorUrl, openExternal, label: "Open event actor profile" }, actor) : actor;
  const assignee = item.assignee?.login || "a user";
  const assigneeUrl = userUrl(host, item.assignee?.login);
  const assigneeNode = assigneeUrl ? Link({ React, url: assigneeUrl, openExternal, label: "Open assignee profile" }, assignee) : assignee;
  switch (item?.kind) {
    case "comment": return [actorNode, " left a note"];
    case "label": return [actorNode, ` ${item.action === "labeled" ? "added" : "removed"} label ${item.label?.name || "(unknown)"}`];
    case "assignment": return [actorNode, ` ${item.action === "assigned" ? "assigned" : "unassigned"} `, assigneeNode];
    case "milestone": return [actorNode, ` ${item.action === "milestoned" ? "added" : "removed"} milestone ${item.milestone?.title || "(unknown)"}`];
    case "state": return [actorNode, ` marked the issue ${item.state || "updated"}${item.reason ? ` (${item.reason})` : ""}`];
    case "rename": return [actorNode, ` changed the title${item.previousTitle || item.currentTitle ? `: ${display(item.previousTitle)} → ${display(item.currentTitle)}` : ""}`];
    case "reference": return [actorNode, ` referenced ${item.target?.oid ? `commit ${item.target.oid}` : "related work"}`];
    case "transfer": return [actorNode, ` transferred this issue${item.fromRepository || item.toRepository ? `: ${display(item.fromRepository)} → ${display(item.toRepository)}` : ""}`];
    default: return [actorNode, ` · ${item?.type || "Timeline event"} · ${display(item?.createdAt)}`];
  }
}

function tokenStyles() {
  return {
    color: "var(--color-token-text-primary, currentColor)",
    background: "var(--color-token-main-surface-primary, transparent)",
    borderColor: "var(--color-token-border-light, currentColor)",
  };
}

function createStyles() {
  return `.github-issues-route button,.github-issues-route input{font:inherit}.github-issues-route button:focus-visible,.github-issues-route input:focus-visible,.github-issues-route a:focus-visible,.github-issues-route [role="button"]:focus-visible{outline:2px solid var(--color-token-text-link-foreground, var(--color-token-link, currentColor));outline-offset:2px}.github-issues-route button{cursor:pointer}.github-issues-route button[aria-pressed="true"]{font-weight:600}.github-issues-route a{color:var(--color-token-text-link-foreground, var(--color-token-link, currentColor))}.github-issues-route-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.github-issues-route-main{display:grid;grid-template-columns:minmax(280px,36%) minmax(0,1fr);flex:1;min-height:0}.github-issues-route-inbox{min-width:0;overflow:auto;border-right:1px solid var(--color-token-border-light, currentColor)}.github-issues-route-detail{min-width:0;overflow:auto;padding:18px 22px}@media (max-width:760px){.github-issues-route-toolbar input{min-width:120px;flex:1}.github-issues-route-main{display:flex;flex-direction:column}.github-issues-route-inbox{max-height:42vh;border-right:0;border-bottom:1px solid var(--color-token-border-light, currentColor)}.github-issues-route-detail{min-height:360px;padding:16px}}`;
}

function node(React, type, props, ...children) {
  return React.createElement(type, props, ...children);
}

export function createSafeExternalLink(React, openExternal, url, label, children) {
  const invoke = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    try { openExternal?.(url); } catch {}
  };
  const invokeAuxiliary = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (event?.button === 1) {
      try { openExternal?.(url); } catch {}
    }
  };
  return node(React, "button", {
    type: "button",
    onClick: invoke,
    onAuxClick: invokeAuxiliary,
    "aria-label": label,
    style: {
      color: "var(--color-token-text-link-foreground, var(--color-token-link, currentColor))",
      background: "transparent",
      border: 0,
      padding: 0,
      textDecoration: "underline",
      cursor: "pointer",
    },
  }, children);
}

function Link({ React, url, openExternal, children: propChildren, label }, children) {
  const content = propChildren ?? children;
  if (!url) return node(React, "span", null, content);
  return createSafeExternalLink(React, openExternal, url, label, content);
}

function Button({ React, components, label, onClick, pressed = false, disabled = false }) {
  const SharedButton = typeof components?.Button === "function" ? components.Button : null;
  const buttonProps = {
    type: "button",
    onClick,
    disabled,
    "aria-label": label,
    "aria-pressed": pressed,
    style: { ...tokenStyles(), border: "1px solid var(--color-token-border-light, currentColor)", borderRadius: "6px", padding: "6px 10px" },
  };
  return node(React, SharedButton || "button", buttonProps, label);
}

function ListRow({ React, issue, selected, onSelect, host, openExternal }) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const repoLink = repositoryUrl(host, issue.repository);
  const authorUrl = userUrl(host, issue.author);
  return node(React, "div", {
    role: "group",
    style: {
      display: "block", width: "100%", padding: "12px 14px",
      borderBottom: "1px solid var(--color-token-border-light, currentColor)", background: selected ? "var(--color-token-bg-secondary, transparent)" : "transparent",
      color: "var(--color-token-text-primary, currentColor)",
    },
  },
  node(React, "div", { style: { fontSize: "12px", color: "var(--color-token-text-secondary, currentColor)" } },
    repoLink ? Link({ React, url: repoLink, openExternal, label: "Open repository" }, display(issue.repository)) : display(issue.repository),
    ` · #${display(issue.number)}`,
  ),
  node(React, "button", {
    type: "button",
    onClick: onSelect,
    "aria-pressed": selected,
    "aria-label": `${display(issue.repository)} Issue ${display(issue.number)} ${display(issue.title)}`,
    style: {
      display: "block", width: "100%", textAlign: "left", marginTop: "6px", padding: 0, border: 0,
      background: "transparent", color: "inherit", cursor: "pointer",
    },
  },
    node(React, "div", { style: { fontSize: "14px", fontWeight: 600 } }, display(issue.title)),
  ),
  node(React, "div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "6px", fontSize: "12px", color: "var(--color-token-text-secondary, currentColor)" } },
    `${display(issue.state).toLowerCase()} · `,
    authorUrl ? Link({ React, url: authorUrl, openExternal, label: "Open author profile" }, display(issue.author)) : display(issue.author, "unknown author"),
    ` · ${display(issue.commentCount, "0")} notes · ${formatRelative(issue.updatedAt)}`,
    labels.length > 0 ? node(React, "span", null, " · ", ...labelNodes(React, labels)) : null,
    issue.assignees?.length > 0 ? ` · ${issue.assignees.join(", ")}` : null,
  ));
}

function TimelineEvent({ React, item, Markdown, openExternal, host }) {
  const targetUrl = item?.target?.url || commitUrl(host, item?.target?.repository, item?.target?.oid);
  const fromUrl = repositoryUrl(host, item?.fromRepository);
  const toUrl = repositoryUrl(host, item?.toRepository);
  const commitMessage = item?.kind === "reference" && typeof item.target?.message === "string" ? item.target.message.split("\n", 1)[0] : null;
  return node(React, "article", { style: { padding: "12px 0", borderBottom: "1px solid var(--color-token-border-light, currentColor)" } },
    node(React, "div", { style: { fontSize: "13px" } }, ...timelineEventText(React, item, host, openExternal)),
    node(React, "div", { style: { marginTop: "4px", fontSize: "12px", color: "var(--color-token-text-secondary, currentColor)" } }, display(item?.createdAt)),
    item?.kind === "transfer" && (fromUrl || toUrl)
      ? node(React, "div", { style: { marginTop: "4px" } },
        fromUrl ? Link({ React, url: fromUrl, openExternal, label: "Open source repository" }, display(item.fromRepository)) : display(item.fromRepository),
        " → ",
        toUrl ? Link({ React, url: toUrl, openExternal, label: "Open destination repository" }, display(item.toRepository)) : display(item.toRepository),
      )
      : null,
    item?.kind === "comment" && item.body
      ? node(React, "div", { style: { marginTop: "8px" } }, Markdown ? node(React, Markdown, { content: item.body, source: item.body, markdown: item.body, children: item.body }) : node(React, "div", { style: { whiteSpace: "pre-wrap" } }, item.body))
      : item?.kind === "reference" && targetUrl
        ? node(React, "div", { style: { marginTop: "4px" } },
          Link({ React, url: targetUrl, openExternal, label: "Open related reference" }, display(item.target.title || item.target.repository || item.target.oid)),
          commitMessage ? node(React, "div", { style: { marginTop: "3px", color: "var(--color-token-text-secondary, currentColor)" } }, commitMessage) : null,
        )
        : null,
  );
}

function renderIssueBody(React, issue, Markdown) {
  if (!issue?.body) return node(React, "p", { style: { color: "var(--color-token-text-secondary, currentColor)" } }, "No issue body");
  return Markdown
    ? node(React, Markdown, { content: issue.body, source: issue.body, markdown: issue.body, children: issue.body })
    : node(React, "div", { style: { whiteSpace: "pre-wrap" } }, issue.body);
}

function ErrorMessage({ React, error }) {
  if (!error) return null;
  const messages = {
    "gh-missing": "GitHub CLI is unavailable",
    "gh-upgrade-required": "GitHub CLI needs an upgrade",
    "auth-required": "Sign in to GitHub CLI to view Issues",
    unauthorized: "GitHub authorization was denied",
    offline: "GitHub could not be reached",
    "rate-limited": "GitHub API rate limit reached",
    "invalid-response": "GitHub returned an incomplete response",
  };
  return node(React, "div", { role: "alert", style: { padding: "12px 14px", color: "var(--color-token-error-foreground, currentColor)" } }, messages[error.code] || "GitHub Issues request failed");
}

export function createIssuesRoute(deps = {}) {
  const React = deps.React;
  if (!React || typeof React.createElement !== "function") throw new TypeError("React dependency is required");
  const Markdown = deps.Markdown;
  const openExternal = deps.openExternal;
  const components = deps.components || {};

  function IssuesRoute() {
    const [state, dispatch] = React.useReducer(issuesReducer, undefined, initialIssuesState);
    const pending = React.useRef(Object.create(null));
    const listDebounce = React.useRef(null);
    const mounted = React.useRef(true);
    const renderButton = (props) => Button({ React, components, ...props });

    const cancel = React.useCallback((requestId) => {
      if (!requestId) return;
      try {
        const request = bridge()?.request;
        void Promise.resolve(request?.({ version: 1, requestId: randomRequestId("cancel"), operation: "cancel", input: { targetRequestId: requestId } })).catch(() => {});
      } catch {}
    }, []);

    const cancelPending = React.useCallback((slot) => {
      const requestId = pending.current[slot];
      if (!requestId) return;
      cancel(requestId);
      if (pending.current[slot] === requestId) delete pending.current[slot];
    }, [cancel]);

    const changeFilter = React.useCallback((action) => {
      cancelPending("list");
      cancelPending("detail");
      cancelPending("timeline");
      dispatch(action);
    }, [cancelPending]);

    const send = React.useCallback((slot, operation, input, startAction, successType, errorType, extra = {}) => {
      const previous = pending.current[slot];
      if (previous) cancel(previous);
      const requestId = randomRequestId(slot);
      pending.current[slot] = requestId;
      dispatch({ ...startAction, requestId, ...extra });
      const request = bridge()?.request;
      if (typeof request !== "function") {
        if (pending.current[slot] === requestId) delete pending.current[slot];
        dispatch({ type: errorType, requestId, error: { code: "adapter-failed", message: "GitHub Issues bridge is unavailable" } });
        return requestId;
      }
      Promise.resolve().then(() => {
        if (!mounted.current || pending.current[slot] !== requestId) return null;
        return request({ version: 1, requestId, operation, input });
      }).then((response) => {
        const status = bridgeResponseStatus(response, requestId);
        if (status === "stale" && pending.current[slot] !== requestId) return;
        if (pending.current[slot] !== requestId) return;
        if (pending.current[slot] === requestId) delete pending.current[slot];
        if (status !== "current") {
          if (mounted.current) dispatch({ type: errorType, requestId, error: { code: "invalid-response", message: "GitHub Issues bridge returned an invalid response" }, ...extra });
          return;
        }
        if (!mounted.current) return;
        if (response.ok) dispatch({ type: successType, requestId, data: response.data ?? {}, ...extra });
        else dispatch({ type: errorType, requestId, error: safeError(response.error), ...extra });
      }).catch((error) => {
        if (pending.current[slot] === requestId) delete pending.current[slot];
        if (mounted.current) dispatch({ type: errorType, requestId, error: safeError(error), ...extra });
      });
      return requestId;
    }, [cancel]);

    // A null host intentionally asks the adapter to select GitHub CLI's active authenticated host.
    const loadCapabilities = React.useCallback((host = null) => send("capabilities", "capabilities", { host }, { type: "capabilities-start" }, "capabilities-success", "capabilities-error"), [send]);
    const loadList = React.useCallback((append = false) => {
      if (listDebounce.current !== null) {
        clearTimeout(listDebounce.current);
        listDebounce.current = null;
      }
      if (!state.host) return null;
      return send("list", "listIssues", {
        host: state.host,
        view: state.view,
        state: state.stateFilter,
        repository: state.repository.trim() || null,
        text: state.text,
        cursor: append ? state.listPage.endCursor : null,
      }, { type: "list-start" }, "list-success", "list-error", { append });
    }, [send, state.host, state.view, state.stateFilter, state.repository, state.text, state.listPage.endCursor]);
    const loadDetail = React.useCallback((issue) => {
      if (!state.host || !issue?.id) return null;
      const requestId = randomRequestId("detail");
      const previous = pending.current.detail;
      if (previous) cancel(previous);
      pending.current.detail = requestId;
      dispatch({ type: "select", issueId: issue.id, requestId });
      dispatch({ type: "detail-start", requestId });
      const request = bridge()?.request;
      if (typeof request !== "function") {
        if (pending.current.detail === requestId) delete pending.current.detail;
        dispatch({ type: "detail-error", requestId, error: { code: "adapter-failed", message: "GitHub Issues bridge is unavailable" } });
        return requestId;
      }
      Promise.resolve().then(() => {
        if (!mounted.current || pending.current.detail !== requestId) return null;
        return request({ version: 1, requestId, operation: "getIssue", input: { host: state.host, nodeId: issue.id } });
      }).then((response) => {
        const status = bridgeResponseStatus(response, requestId);
        if (status === "stale" && pending.current.detail !== requestId) return;
        if (pending.current.detail !== requestId) return;
        delete pending.current.detail;
        if (status !== "current") {
          if (mounted.current) dispatch({ type: "detail-error", requestId, error: { code: "invalid-response", message: "GitHub Issues bridge returned an invalid response" } });
          return;
        }
        if (mounted.current) {
          if (response.ok) dispatch({ type: "detail-success", requestId, data: response.data ?? {} });
          else dispatch({ type: "detail-error", requestId, error: safeError(response.error) });
        }
      }).catch((error) => {
        if (pending.current.detail === requestId) delete pending.current.detail;
        if (mounted.current) dispatch({ type: "detail-error", requestId, error: safeError(error) });
      });
      return requestId;
    }, [cancel, state.host]);
    const loadTimeline = React.useCallback(() => {
      const issueId = state.selectedId;
      const cursor = state.timeline.pageInfo?.endCursor;
      if (!state.host || !issueId || !cursor) return null;
      return send("timeline", "getIssueTimelinePage", { host: state.host, nodeId: issueId, cursor }, { type: "timeline-start" }, "timeline-success", "timeline-error", { append: true });
    }, [send, state.host, state.selectedId, state.timeline.pageInfo?.endCursor]);

    React.useEffect(() => {
      mounted.current = true;
      loadCapabilities(null);
      return () => {
        mounted.current = false;
        for (const slot of Object.keys(pending.current)) cancelPending(slot);
      };
    }, [loadCapabilities, cancelPending]);
    const previousHost = React.useRef(state.host);
    React.useEffect(() => {
      if (previousHost.current === state.host) return;
      for (const slot of ["list", "detail", "timeline"]) cancelPending(slot);
      previousHost.current = state.host;
    }, [state.host, cancelPending]);
    React.useEffect(() => {
      if (!state.host || state.capabilities.status === "loading") return undefined;
      const timer = setTimeout(() => {
        if (listDebounce.current === timer) listDebounce.current = null;
        loadList(false);
      }, 250);
      listDebounce.current = timer;
      return () => {
        clearTimeout(timer);
        if (listDebounce.current === timer) listDebounce.current = null;
      };
    }, [loadList, state.host, state.view, state.stateFilter, state.repository, state.text, state.capabilities.status]);

    const style = { ...tokenStyles(), display: "flex", flexDirection: "column", minHeight: "420px", height: "100%", fontSize: "14px" };
    const tabs = ["assigned", "authored", "all"];
    const states = ["open", "closed", "all"];
    const issue = state.detail.issue;
    const issueRepositoryUrl = repositoryUrl(state.host, issue?.repository);
    const issueAuthorUrl = userUrl(state.host, issue?.author);
    const listRateLimit = rateLimitText(state.list.rateLimit);
    const detailRateLimit = rateLimitText(state.detail.rateLimit);
    const capabilitiesRateLimit = rateLimitText(state.capabilities.rateLimit);
    const timelineRateLimit = rateLimitText(state.timeline.rateLimit);
    return node(React, "div", { className: "github-issues-route", style },
      node(React, "style", null, createStyles()),
      node(React, "header", { style: { display: "flex", alignItems: "center", gap: "12px", padding: "14px 18px", borderBottom: "1px solid var(--color-token-border-light, currentColor)" } },
        node(React, "strong", null, "Issues"),
        node(React, "span", { style: { color: "var(--color-token-text-secondary, currentColor)", fontSize: "12px" } }, display(state.host, "No GitHub host")),
        state.capabilities.status === "loading" ? node(React, "span", { role: "status", style: { color: "var(--color-token-text-secondary, currentColor)", fontSize: "12px" } }, "Checking GitHub access…") : null,
        state.capabilities.status === "error" ? ErrorMessage({ React, error: state.capabilities.error }) : null,
        capabilitiesRateLimit ? node(React, "span", { role: "status", style: { color: "var(--color-token-text-secondary, currentColor)", fontSize: "12px" } }, capabilitiesRateLimit) : null,
      ),
      node(React, "div", { className: "github-issues-route-toolbar", style: { padding: "12px 18px", borderBottom: "1px solid var(--color-token-border-light, currentColor)" } },
        ...tabs.map((view) => renderButton({ label: view[0].toUpperCase() + view.slice(1), pressed: state.view === view, onClick: () => changeFilter({ type: "view-set", view }) })),
        node(React, "span", { style: { width: "1px", height: "20px", background: "var(--color-token-border-light, currentColor)", margin: "0 4px" } }),
        ...states.map((filter) => renderButton({ label: filter[0].toUpperCase() + filter.slice(1), pressed: state.stateFilter === filter, onClick: () => changeFilter({ type: "state-set", stateFilter: filter }) })),
        node(React, "label", { style: { display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          node(React, "span", null, "Repository"),
          node(React, "input", { value: state.repository, onChange: (event) => changeFilter({ type: "repository-set", repository: event.target.value }), placeholder: "owner/name", "aria-label": "Repository filter", style: { ...tokenStyles(), border: "1px solid var(--color-token-border-light, currentColor)", borderRadius: "6px", padding: "6px 8px", width: "150px" } }),
        ),
        node(React, "label", { style: { display: "flex", alignItems: "center", gap: "6px" } },
          node(React, "span", null, "Text"),
          node(React, "input", { value: state.text, onChange: (event) => changeFilter({ type: "text-set", text: event.target.value }), placeholder: "Search", "aria-label": "Text filter", style: { ...tokenStyles(), border: "1px solid var(--color-token-border-light, currentColor)", borderRadius: "6px", padding: "6px 8px", width: "170px" } }),
        ),
        renderButton({ label: "Refresh", onClick: () => loadList(false), disabled: state.list.status === "loading" || state.list.status === "refreshing" }),
      ),
      node(React, "main", { className: "github-issues-route-main" },
        node(React, "section", { className: "github-issues-route-inbox", "aria-label": "Issue inbox" },
          state.list.status === "loading" ? node(React, "p", { style: { padding: "18px", color: "var(--color-token-text-secondary, currentColor)" } }, "Loading Issues…") : null,
          state.list.status === "error" ? ErrorMessage({ React, error: state.list.error }) : null,
          listRateLimit ? node(React, "p", { role: "status", style: { padding: "8px 14px", color: "var(--color-token-text-secondary, currentColor)", fontSize: "12px" } }, listRateLimit) : null,
          state.list.status === "partial" ? node(React, "p", { role: "status", style: { padding: "10px 14px", color: "var(--color-token-text-secondary, currentColor)" } }, "Some Issue fields were unavailable") : null,
          state.list.status !== "loading" && state.list.status !== "error" && state.list.items.length === 0 ? node(React, "p", { style: { padding: "18px", color: "var(--color-token-text-secondary, currentColor)" } }, "No Issues match these filters") : null,
          ...state.list.items.map((item) => ListRow({ React, issue: item, host: state.host, openExternal, selected: item.id === state.selectedId, onSelect: () => loadDetail(item) })),
          state.listPage.hasNextPage ? node(React, "div", { style: { padding: "12px 14px" } }, renderButton({ label: "Next page", onClick: () => loadList(true), disabled: state.list.status === "loading" || state.list.status === "refreshing" })) : null,
        ),
        node(React, "section", { className: "github-issues-route-detail", "aria-label": "Issue detail" },
          !state.selectedId ? node(React, "p", { style: { color: "var(--color-token-text-secondary, currentColor)" } }, "Select an Issue to view its details") : null,
          state.detail.status === "loading" ? node(React, "p", { style: { color: "var(--color-token-text-secondary, currentColor)" } }, "Loading Issue details…") : null,
          state.detail.status === "error" ? ErrorMessage({ React, error: state.detail.error }) : null,
          issue ? node(React, "article", null,
            node(React, "header", { style: { borderBottom: "1px solid var(--color-token-border-light, currentColor)", paddingBottom: "14px", marginBottom: "16px" } },
              node(React, "h2", { style: { margin: 0, fontSize: "20px", lineHeight: 1.3 } }, display(issue.title)),
              node(React, "div", { style: { marginTop: "7px", color: "var(--color-token-text-secondary, currentColor)" } },
                issueRepositoryUrl ? Link({ React, url: issueRepositoryUrl, openExternal, label: "Open repository" }, display(issue.repository)) : display(issue.repository),
                ` · #${display(issue.number)} · ${display(issue.state).toLowerCase()}`,
              ),
              issue.url ? node(React, "div", { style: { marginTop: "7px" } }, Link({ React, url: issue.url, openExternal, label: "Open Issue in browser" }, "Open in browser")) : null,
              node(React, "div", { style: { marginTop: "9px", color: "var(--color-token-text-secondary, currentColor)", fontSize: "13px" } },
                "by ", issueAuthorUrl ? Link({ React, url: issueAuthorUrl, openExternal, label: "Open author profile" }, display(issue.author)) : display(issue.author, "unknown author"),
                ` · created ${display(issue.createdAt)} · updated ${formatRelative(issue.updatedAt)}`,
              ),
              issue.stateReason ? node(React, "div", { style: { marginTop: "5px", color: "var(--color-token-text-secondary, currentColor)", fontSize: "13px" } }, `Reason: ${issue.stateReason}`) : null,
              issue.labels?.length ? node(React, "div", { style: { marginTop: "8px", color: "var(--color-token-text-secondary, currentColor)", fontSize: "13px" } }, ...labelNodes(React, issue.labels)) : null,
              issue.assignees?.length ? node(React, "div", { style: { marginTop: "5px", color: "var(--color-token-text-secondary, currentColor)", fontSize: "13px" } }, issue.assignees.join(", ")) : null,
              issue.milestone?.title ? node(React, "div", { style: { marginTop: "5px", color: "var(--color-token-text-secondary, currentColor)", fontSize: "13px" } }, milestoneText(issue.milestone)) : null,
              issue.projects?.length ? node(React, "div", { style: { marginTop: "5px", color: "var(--color-token-text-secondary, currentColor)", fontSize: "13px" } }, `Projects: ${issue.projects.map((project) => project.title || project.number).join(", ")}`) : null,
            ),
            state.detail.status === "partial" ? node(React, "p", { role: "status", style: { color: "var(--color-token-text-secondary, currentColor)" } }, "Some Issue fields were unavailable") : null,
            detailRateLimit ? node(React, "p", { role: "status", style: { color: "var(--color-token-text-secondary, currentColor)", fontSize: "12px" } }, detailRateLimit) : null,
            node(React, "section", { "aria-label": "Issue body", style: { paddingBottom: "18px" } }, renderIssueBody(React, issue, Markdown)),
            node(React, "section", { "aria-label": "Issue timeline" },
              node(React, "h3", { style: { margin: "0 0 4px", fontSize: "15px" } }, "Timeline"),
              state.timeline.status === "partial" ? node(React, "p", { role: "status", style: { color: "var(--color-token-text-secondary, currentColor)", fontSize: "13px" } }, "Some timeline fields were unavailable") : null,
              state.timeline.status === "error" ? ErrorMessage({ React, error: state.timeline.error }) : null,
              timelineRateLimit ? node(React, "p", { role: "status", style: { color: "var(--color-token-text-secondary, currentColor)", fontSize: "12px" } }, timelineRateLimit) : null,
              state.timeline.items.length === 0 && state.timeline.status !== "loading" && state.timeline.status !== "error" ? node(React, "p", { style: { color: "var(--color-token-text-secondary, currentColor)" } }, "No timeline activity") : null,
              ...state.timeline.items.map((item, index) => node(React, TimelineEvent, { key: item.id || `${item.type}-${index}`, React, item, Markdown, openExternal, host: state.host })),
              state.timeline.pageInfo?.hasNextPage ? node(React, "div", { style: { marginTop: "12px" } }, renderButton({ label: "Load more timeline", onClick: loadTimeline, disabled: state.timeline.status === "loading" || state.timeline.status === "refreshing" })) : null,
            ),
          ) : null,
        ),
      ),
    );
  }

  return IssuesRoute;
}
