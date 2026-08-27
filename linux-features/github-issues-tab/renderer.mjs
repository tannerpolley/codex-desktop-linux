const envelope = (operation, input) => ({ version: 1, requestId: `${operation}-${crypto.randomUUID()}`, operation, input });

function message(response) {
  if (!response?.ok) throw new Error(response?.error?.message || "GitHub Issues request failed");
  return response.data;
}

export function createIssuesRoute({ React }) {
  const h = React.createElement;

  function IssuesRoute() {
    const [account, setAccount] = React.useState(null);
    const [issues, setIssues] = React.useState([]);
    const [selected, setSelected] = React.useState(null);
    const [detail, setDetail] = React.useState(null);
    const [view, setView] = React.useState("all");
    const [state, setState] = React.useState("open");
    const [repository, setRepository] = React.useState(null);
    const [query, setQuery] = React.useState("");
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState(null);
    const bridge = window.electronBridge?.githubIssues?.request;

    const load = React.useCallback(async (nextAccount = account) => {
      setLoading(true);
      setError(null);
      try {
        if (typeof bridge !== "function") throw new Error("GitHub Issues bridge is unavailable");
        const current = nextAccount || message(await bridge(envelope("capabilities", { host: null })));
        setAccount(current);
        const result = message(await bridge(envelope("listIssues", { host: current.host, view, state, repository, query, cursor: null })));
        setIssues(result.issues);
        if (selected && !result.issues.some(({ id }) => id === selected.id)) {
          setSelected(null);
          setDetail(null);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    }, [account, bridge, query, repository, selected, state, view]);

    React.useEffect(() => { void load(); }, [view, state, repository]);

    async function choose(issue) {
      setSelected(issue);
      setDetail(null);
      setError(null);
      try {
        setDetail(message(await bridge(envelope("getIssue", { host: account.host, nodeId: issue.id }))).issue);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }

    const repositories = [...new Set(issues.map((issue) => issue.repository).filter(Boolean))].sort();
    const select = (label, value, onChange, options) => h("label", { className: "flex items-center gap-2 text-sm" },
      h("span", { className: "sr-only" }, label),
      h("select", { className: "rounded-md border border-token-border-default bg-transparent px-2 py-1", value, onChange: (event) => onChange(event.target.value) },
        options.map(([id, text]) => h("option", { key: id, value: id }, text))),
    );

    const toolbar = h("div", { className: "flex flex-wrap items-center gap-2 border-b border-token-border-default px-4 py-3" },
      h("form", { className: "flex min-w-52 flex-1 gap-2", onSubmit: (event) => { event.preventDefault(); void load(); } },
        h("input", { "aria-label": "Search issues", className: "min-w-0 flex-1 rounded-md border border-token-border-default bg-transparent px-3 py-1.5", placeholder: "Search issues", value: query, onChange: (event) => setQuery(event.target.value) }),
        h("button", { className: "rounded-md border border-token-border-default px-3 py-1.5", type: "submit" }, "Search")),
      select("Issue view", view, setView, [["all", "All"], ["assigned", "Assigned"], ["authored", "Authored"]]),
      select("Issue state", state, setState, [["open", "Open"], ["closed", "Closed"], ["all", "All states"]]),
      select("Repository", repository || "", (value) => setRepository(value || null), [["", "All repositories"], ...repositories.map((name) => [name, name])]),
      h("button", { "aria-label": "Refresh issues", className: "rounded-md border border-token-border-default px-3 py-1.5", disabled: loading, onClick: () => void load(), type: "button" }, loading ? "Refreshing…" : "Refresh"),
    );

    const list = h("div", { "data-testid": "issues-list", className: "min-h-0 overflow-y-auto" },
      error && h("div", { className: "m-4 rounded-md border border-token-border-danger bg-token-surface-danger p-3 text-sm", role: "alert" }, error),
      !loading && !error && issues.length === 0 && h("p", { className: "p-6 text-sm text-token-text-secondary" }, "No issues match these filters."),
      issues.map((issue) => h("button", {
        "data-testid": `issue-${issue.number}`, key: issue.id, type: "button", onClick: () => void choose(issue),
        className: `flex w-full flex-col gap-1 border-b border-token-border-default px-4 py-3 text-left hover:bg-token-surface-secondary ${selected?.id === issue.id ? "bg-token-surface-secondary" : ""}`,
      },
      h("span", { className: "font-medium" }, issue.title),
      h("span", { className: "text-xs text-token-text-secondary" }, `${issue.repository} #${issue.number} · ${issue.author || "unknown"} · ${issue.commentCount} comments`),
      issue.labels.length > 0 && h("span", { className: "flex flex-wrap gap-1" }, issue.labels.map((label) => h("span", { key: label.name, className: "rounded-full border border-token-border-default px-2 py-0.5 text-xs" }, label.name))),
      )),
    );

    const body = detail || selected;
    const detailPanel = h("aside", { "data-testid": "issue-detail", className: "min-h-0 overflow-y-auto border-l border-token-border-default p-5" },
      !body ? h("div", { className: "flex h-full items-center justify-center text-sm text-token-text-secondary" }, "Select an issue to view") : h(React.Fragment, null,
        h("div", { className: "mb-4 flex items-start justify-between gap-3" },
          h("div", null, h("h2", { className: "text-lg font-semibold" }, body.title), h("p", { className: "text-sm text-token-text-secondary" }, `${body.repository} #${body.number}`)),
          h("a", { className: "rounded-md border border-token-border-default px-3 py-1.5 text-sm", href: body.url, rel: "noreferrer", target: "_blank" }, "Open in GitHub")),
        h("pre", { className: "mb-6 whitespace-pre-wrap font-sans text-sm" }, body.body || "No description."),
        (body.comments || []).map((comment) => h("article", { key: comment.id, className: "mb-3 rounded-md border border-token-border-default p-3" },
          h("div", { className: "mb-2 text-xs text-token-text-secondary" }, `${comment.author || "unknown"} · ${new Date(comment.createdAt).toLocaleString()}`),
          h("div", { className: "whitespace-pre-wrap text-sm" }, comment.body))),
      ),
    );

    return h("section", { "data-testid": "issues-route", className: "flex h-full min-h-0 w-full flex-col bg-surface" },
      h("header", { className: "px-5 pb-3 pt-5" }, h("h1", { className: "text-xl font-semibold" }, "Issues"), h("p", { className: "text-sm text-token-text-secondary" }, account ? `Track work across GitHub as ${account.login}.` : "Track work across GitHub.")),
      toolbar,
      h("div", { className: "grid min-h-0 flex-1 grid-cols-[minmax(20rem,2fr)_minmax(22rem,3fr)]" }, list, detailPanel),
    );
  }

  return IssuesRoute;
}
