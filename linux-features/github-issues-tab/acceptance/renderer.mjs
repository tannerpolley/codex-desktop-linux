import { createIssuesSidePanel } from "../renderer.mjs";
import { details, issues, rateLimit } from "../preview/fixtures.mjs";

const React = window.acceptanceReact;
const response = (requestId, data) => ({ version: 1, requestId, ok: true, data, error: null });

window.electronBridge = {
  githubIssues: {
    async request(request) {
      switch (request.operation) {
        case "capabilities":
          return response(request.requestId, { host: "github.com", viewerLogin: "acceptance-user", repository: "cli/cli", rateLimit, warnings: [] });
        case "listIssues":
          return response(request.requestId, { host: "github.com", viewerLogin: "acceptance-user", issues, pageInfo: { hasNextPage: false, endCursor: null }, rateLimit, warnings: [] });
        case "getIssue":
          return response(request.requestId, details[request.input.nodeId]);
        case "getIssueTimelinePage":
          return response(request.requestId, { items: [], pageInfo: { hasNextPage: false, endCursor: null }, rateLimit, warnings: [] });
        case "cancel":
          return response(request.requestId, {});
        default:
          return { version: 1, requestId: request.requestId, ok: false, data: null, error: { code: "invalid-response", message: "Unsupported acceptance operation" } };
      }
    },
  },
};

function Markdown({ children }) {
  return React.createElement("pre", null, String(children ?? ""));
}

const IssuesPanel = createIssuesSidePanel({
  React,
  Markdown,
  hostId: "github.com",
  root: "/fixture/cli-cli",
  getSetting: async () => ({ value: true }),
  openExternal() {},
});

window.acceptanceCreateRoot(document.getElementById("root")).render(React.createElement(IssuesPanel));
