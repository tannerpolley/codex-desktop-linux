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
    detail: operationState({ issue: null }),
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

export function issuesReducer(state, action) {
  if (!state || !action || typeof action.type !== "string") return state;
  switch (action.type) {
    case "host-set":
      if (state.host === (action.host ?? null)) return state;
      return resetDataForHost(state, action.host);
    case "filters-set": {
      const next = {
        ...state,
        view: ["assigned", "authored", "all"].includes(action.view) ? action.view : state.view,
        stateFilter: ["open", "closed", "all"].includes(action.stateFilter) ? action.stateFilter : state.stateFilter,
        repository: typeof action.repository === "string" ? action.repository : state.repository,
        text: typeof action.text === "string" ? action.text : state.text,
      };
      return next;
    }
    case "view-set":
      return ["assigned", "authored", "all"].includes(action.view) ? { ...state, view: action.view } : state;
    case "state-set":
      return ["open", "closed", "all"].includes(action.stateFilter) ? { ...state, stateFilter: action.stateFilter } : state;
    case "repository-set":
      return typeof action.repository === "string" ? { ...state, repository: action.repository } : state;
    case "text-set":
      return typeof action.text === "string" ? { ...state, text: action.text } : state;
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
      return {
        ...state,
        detail: { ...state.detail, status: statusFor(data), error: null, warnings: warningsValue(data.warnings), issue: data.issue ?? null },
        timeline: {
          ...state.timeline,
          requestId: state.timeline.requestId,
          status: statusFor(data, "ready"),
          error: null,
          warnings: warningsValue([...(data.warnings ?? []), ...(timeline.warnings ?? [])]),
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

function eventText(item) {
  const actor = item.actor?.login || "Someone";
  switch (item?.kind) {
    case "comment": return `${actor} left a note`;
    case "label": return `${actor} ${item.action === "labeled" ? "added" : "removed"} label ${item.label?.name || "(unknown)"}`;
    case "assignment": return `${actor} ${item.action === "assigned" ? "assigned" : "unassigned"} ${item.assignee?.login || "a user"}`;
    case "milestone": return `${actor} ${item.action === "milestoned" ? "added" : "removed"} milestone ${item.milestone?.title || "(unknown)"}`;
    case "state": return `${actor} marked the issue ${item.state || "updated"}`;
    case "rename": return `${actor} changed the title`;
    case "reference": return `${actor} referenced related work`;
    case "transfer": return `${actor} transferred this issue`;
    default: return `${item?.type || "Timeline event"} · ${display(item?.createdAt)}`;
  }
}

function tokenStyles() {
  return {
    color: "var(--text-primary)",
    background: "var(--background-primary)",
    borderColor: "var(--border-subtle)",
  };
}

function createStyles() {
  return `.github-issues-route button,.github-issues-route input{font:inherit}.github-issues-route button:focus-visible,.github-issues-route input:focus-visible,.github-issues-route a:focus-visible{outline:2px solid var(--text-link);outline-offset:2px}.github-issues-route button{cursor:pointer}.github-issues-route button[aria-pressed="true"]{font-weight:600}.github-issues-route a{color:var(--text-link)}`;
}

function node(React, type, props, ...children) {
  return React.createElement(type, props, ...children);
}

function Link({ React, url, openExternal, children: propChildren, label }, children) {
  const content = propChildren ?? children;
  if (!url) return node(React, "span", null, content);
  const onClick = (event) => {
    event.preventDefault();
    try { openExternal?.(url); } catch {}
  };
  return node(React, "a", { href: url, onClick, "aria-label": label }, content);
}

function Button({ React, label, onClick, pressed = false, disabled = false }) {
  return node(React, "button", {
    type: "button",
    onClick,
    disabled,
    "aria-label": label,
    "aria-pressed": pressed,
    style: { ...tokenStyles(), border: "1px solid var(--border-subtle)", borderRadius: "6px", padding: "6px 10px" },
  }, label);
}

function ListRow({ React, issue, selected, onSelect }) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return node(React, "button", {
    type: "button",
    onClick: onSelect,
    "aria-pressed": selected,
    "aria-label": `${display(issue.repository)} Issue ${display(issue.number)} ${display(issue.title)}`,
    style: {
      display: "block", width: "100%", textAlign: "left", padding: "12px 14px", border: 0,
      borderBottom: "1px solid var(--border-subtle)", background: selected ? "var(--background-secondary)" : "transparent",
      color: "var(--text-primary)", cursor: "pointer",
    },
  },
  node(React, "div", { style: { fontSize: "12px", color: "var(--text-secondary)" } }, `${display(issue.repository)} · #${display(issue.number)}`),
  node(React, "div", { style: { marginTop: "4px", fontSize: "14px", fontWeight: 600 } }, display(issue.title)),
  node(React, "div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "6px", fontSize: "12px", color: "var(--text-secondary)" } },
    `${display(issue.state).toLowerCase()} · ${display(issue.author, "unknown author")} · ${display(issue.commentCount, "0")} notes · ${formatRelative(issue.updatedAt)}`,
    labels.length > 0 ? ` · ${labels.map((label) => label.name).join(", ")}` : null,
    issue.assignees?.length > 0 ? ` · ${issue.assignees.join(", ")}` : null,
  ));
}

function TimelineEvent({ React, item, Markdown, openExternal }) {
  const text = eventText(item);
  return node(React, "article", { style: { padding: "12px 0", borderBottom: "1px solid var(--border-subtle)" } },
    node(React, "div", { style: { fontSize: "13px" } }, text),
    node(React, "div", { style: { marginTop: "4px", fontSize: "12px", color: "var(--text-secondary)" } }, display(item?.createdAt)),
    item?.kind === "comment" && item.body
      ? node(React, "div", { style: { marginTop: "8px" } }, Markdown ? node(React, Markdown, { content: item.body, source: item.body, markdown: item.body }) : node(React, "div", { style: { whiteSpace: "pre-wrap" } }, item.body))
      : item?.kind === "reference" && item.target?.url
        ? node(React, "div", { style: { marginTop: "4px" } }, Link({ React, url: item.target.url, openExternal, label: "Open related reference" }, display(item.target.title || item.target.repository)))
        : null,
  );
}

function renderIssueBody(React, issue, Markdown) {
  if (!issue?.body) return node(React, "p", { style: { color: "var(--text-secondary)" } }, "No issue body");
  return Markdown
    ? node(React, Markdown, { content: issue.body, source: issue.body, markdown: issue.body })
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
  return node(React, "div", { role: "alert", style: { padding: "12px 14px", color: "var(--text-error)" } }, messages[error.code] || "GitHub Issues request failed");
}

export function createIssuesRoute(deps = {}) {
  const React = deps.React;
  if (!React || typeof React.createElement !== "function") throw new TypeError("React dependency is required");
  const Markdown = deps.Markdown;
  const openExternal = deps.openExternal;
  const components = deps.components || {};
  void components;

  function IssuesRoute() {
    const [state, dispatch] = React.useReducer(issuesReducer, undefined, initialIssuesState);
    const pending = React.useRef(Object.create(null));
    const mounted = React.useRef(true);

    const cancel = React.useCallback((requestId) => {
      if (!requestId) return;
      try {
        const request = bridge()?.request;
        request?.({ version: 1, requestId: randomRequestId("cancel"), operation: "cancel", input: { targetRequestId: requestId } });
      } catch {}
    }, []);

    const send = React.useCallback((slot, operation, input, startAction, successType, errorType, extra = {}) => {
      const previous = pending.current[slot];
      if (previous) cancel(previous);
      const requestId = randomRequestId(slot);
      pending.current[slot] = requestId;
      dispatch({ ...startAction, requestId, ...extra });
      const request = bridge()?.request;
      if (typeof request !== "function") {
        dispatch({ type: errorType, requestId, error: { code: "adapter-failed", message: "GitHub Issues bridge is unavailable" } });
        return requestId;
      }
      Promise.resolve().then(() => request({ version: 1, requestId, operation, input })).then((response) => {
        if (!mounted.current) return;
        if (response?.requestId !== requestId) return;
        if (response.ok) dispatch({ type: successType, requestId, data: response.data ?? {}, ...extra });
        else dispatch({ type: errorType, requestId, error: safeError(response.error), ...extra });
      }).catch((error) => {
        if (mounted.current) dispatch({ type: errorType, requestId, error: safeError(error), ...extra });
      });
      return requestId;
    }, [cancel]);

    const loadCapabilities = React.useCallback((host = null) => send("capabilities", "capabilities", { host }, { type: "capabilities-start" }, "capabilities-success", "capabilities-error"), [send]);
    const loadList = React.useCallback((append = false) => {
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
        dispatch({ type: "detail-error", requestId, error: { code: "adapter-failed", message: "GitHub Issues bridge is unavailable" } });
        return requestId;
      }
      Promise.resolve().then(() => request({ version: 1, requestId, operation: "getIssue", input: { host: state.host, nodeId: issue.id } })).then((response) => {
        if (mounted.current && response?.requestId === requestId) {
          if (response.ok) dispatch({ type: "detail-success", requestId, data: response.data ?? {} });
          else dispatch({ type: "detail-error", requestId, error: safeError(response.error) });
        }
      }).catch((error) => mounted.current && dispatch({ type: "detail-error", requestId, error: safeError(error) }));
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
        for (const requestId of Object.values(pending.current)) cancel(requestId);
      };
    }, [loadCapabilities, cancel]);
    React.useEffect(() => {
      if (state.host && state.capabilities.status !== "loading") loadList(false);
    }, [state.host, state.view, state.stateFilter, state.repository, state.text]);

    const style = { ...tokenStyles(), display: "flex", flexDirection: "column", minHeight: "420px", height: "100%", fontSize: "14px" };
    const tabs = ["assigned", "authored", "all"];
    const states = ["open", "closed", "all"];
    const issue = state.detail.issue;
    return node(React, "div", { className: "github-issues-route", style },
      node(React, "style", null, createStyles()),
      node(React, "header", { style: { display: "flex", alignItems: "center", gap: "12px", padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)" } },
        node(React, "strong", null, "Issues"),
        node(React, "span", { style: { color: "var(--text-secondary)", fontSize: "12px" } }, display(state.host, "No GitHub host")),
        state.capabilities.status === "loading" ? node(React, "span", { role: "status", style: { color: "var(--text-secondary)", fontSize: "12px" } }, "Checking GitHub access…") : null,
        state.capabilities.status === "error" ? ErrorMessage({ React, error: state.capabilities.error }) : null,
      ),
      node(React, "div", { style: { display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", padding: "12px 18px", borderBottom: "1px solid var(--border-subtle)" } },
        ...tabs.map((view) => Button({ React, label: view[0].toUpperCase() + view.slice(1), pressed: state.view === view, onClick: () => dispatch({ type: "view-set", view }) })),
        node(React, "span", { style: { width: "1px", height: "20px", background: "var(--border-subtle)", margin: "0 4px" } }),
        ...states.map((filter) => Button({ React, label: filter[0].toUpperCase() + filter.slice(1), pressed: state.stateFilter === filter, onClick: () => dispatch({ type: "state-set", stateFilter: filter }) })),
        node(React, "label", { style: { display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" } },
          node(React, "span", null, "Repository"),
          node(React, "input", { value: state.repository, onChange: (event) => dispatch({ type: "repository-set", repository: event.target.value }), placeholder: "owner/name", "aria-label": "Repository filter", style: { ...tokenStyles(), border: "1px solid var(--border-subtle)", borderRadius: "6px", padding: "6px 8px", width: "150px" } }),
        ),
        node(React, "label", { style: { display: "flex", alignItems: "center", gap: "6px" } },
          node(React, "span", null, "Text"),
          node(React, "input", { value: state.text, onChange: (event) => dispatch({ type: "text-set", text: event.target.value }), placeholder: "Search", "aria-label": "Text filter", style: { ...tokenStyles(), border: "1px solid var(--border-subtle)", borderRadius: "6px", padding: "6px 8px", width: "170px" } }),
        ),
        Button({ React, label: "Refresh", onClick: () => loadList(false), disabled: state.list.status === "loading" || state.list.status === "refreshing" }),
      ),
      node(React, "main", { style: { display: "grid", gridTemplateColumns: "minmax(280px, 36%) minmax(0, 1fr)", flex: 1, minHeight: 0 } },
        node(React, "section", { "aria-label": "Issue inbox", style: { minWidth: 0, overflow: "auto", borderRight: "1px solid var(--border-subtle)" } },
          state.list.status === "loading" ? node(React, "p", { style: { padding: "18px", color: "var(--text-secondary)" } }, "Loading Issues…") : null,
          state.list.status === "error" ? ErrorMessage({ React, error: state.list.error }) : null,
          state.list.status === "partial" ? node(React, "p", { role: "status", style: { padding: "10px 14px", color: "var(--text-secondary)" } }, "Some Issue fields were unavailable") : null,
          state.list.status !== "loading" && state.list.status !== "error" && state.list.items.length === 0 ? node(React, "p", { style: { padding: "18px", color: "var(--text-secondary)" } }, "No Issues match these filters") : null,
          ...state.list.items.map((item) => ListRow({ React, issue: item, selected: item.id === state.selectedId, onSelect: () => loadDetail(item) })),
          state.listPage.hasNextPage ? node(React, "div", { style: { padding: "12px 14px" } }, Button({ React, label: "Next page", onClick: () => loadList(true), disabled: state.list.status === "loading" || state.list.status === "refreshing" })) : null,
        ),
        node(React, "section", { "aria-label": "Issue detail", style: { minWidth: 0, overflow: "auto", padding: "18px 22px" } },
          !state.selectedId ? node(React, "p", { style: { color: "var(--text-secondary)" } }, "Select an Issue to view its details") : null,
          state.detail.status === "loading" ? node(React, "p", { style: { color: "var(--text-secondary)" } }, "Loading Issue details…") : null,
          state.detail.status === "error" ? ErrorMessage({ React, error: state.detail.error }) : null,
          issue ? node(React, "article", null,
            node(React, "header", { style: { borderBottom: "1px solid var(--border-subtle)", paddingBottom: "14px", marginBottom: "16px" } },
              node(React, "h2", { style: { margin: 0, fontSize: "20px", lineHeight: 1.3 } }, display(issue.title)),
              node(React, "div", { style: { marginTop: "7px", color: "var(--text-secondary)" } }, `${display(issue.repository)} · #${display(issue.number)} · ${display(issue.state).toLowerCase()}`),
              issue.url ? node(React, "div", { style: { marginTop: "7px" } }, Link({ React, url: issue.url, openExternal, label: "Open Issue in browser" }, "Open in browser")) : null,
              node(React, "div", { style: { marginTop: "9px", color: "var(--text-secondary)", fontSize: "13px" } }, `by ${display(issue.author, "unknown author")} · created ${display(issue.createdAt)} · updated ${formatRelative(issue.updatedAt)}`),
              issue.labels?.length ? node(React, "div", { style: { marginTop: "8px", color: "var(--text-secondary)", fontSize: "13px" } }, issue.labels.map((label) => label.name).join(", ")) : null,
              issue.assignees?.length ? node(React, "div", { style: { marginTop: "5px", color: "var(--text-secondary)", fontSize: "13px" } }, issue.assignees.join(", ")) : null,
              issue.milestone?.title ? node(React, "div", { style: { marginTop: "5px", color: "var(--text-secondary)", fontSize: "13px" } }, `Milestone: ${issue.milestone.title}`) : null,
              issue.projects?.length ? node(React, "div", { style: { marginTop: "5px", color: "var(--text-secondary)", fontSize: "13px" } }, `Projects: ${issue.projects.map((project) => project.title || project.number).join(", ")}`) : null,
            ),
            node(React, "section", { "aria-label": "Issue body", style: { paddingBottom: "18px" } }, renderIssueBody(React, issue, Markdown)),
            node(React, "section", { "aria-label": "Issue timeline" },
              node(React, "h3", { style: { margin: "0 0 4px", fontSize: "15px" } }, "Timeline"),
              state.timeline.status === "partial" ? node(React, "p", { role: "status", style: { color: "var(--text-secondary)", fontSize: "13px" } }, "Some timeline fields were unavailable") : null,
              state.timeline.status === "error" ? ErrorMessage({ React, error: state.timeline.error }) : null,
              state.timeline.items.length === 0 && state.timeline.status !== "loading" && state.timeline.status !== "error" ? node(React, "p", { style: { color: "var(--text-secondary)" } }, "No timeline activity") : null,
              ...state.timeline.items.map((item, index) => node(React, TimelineEvent, { key: item.id || `${item.type}-${index}`, React, item, Markdown, openExternal })),
              state.timeline.pageInfo?.hasNextPage ? node(React, "div", { style: { marginTop: "12px" } }, Button({ React, label: "Load more timeline", onClick: loadTimeline, disabled: state.timeline.status === "loading" || state.timeline.status === "refreshing" })) : null,
            ),
          ) : null,
        ),
      ),
    );
  }

  return IssuesRoute;
}
