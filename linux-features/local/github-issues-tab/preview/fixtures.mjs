const rateLimit = Object.freeze({ cost: 1, remaining: 4999, resetAt: "2026-08-01T04:00:00Z" });

export const issues = [
  {
    id: "preview-issue-1",
    host: "github.com",
    repository: "cli/cli",
    number: 14031,
    title: "Bug: issue rows should stay readable when one detail is expanded",
    url: "https://github.com/cli/cli/issues/14031",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-07-31T22:21:40Z",
    updatedAt: "2026-07-31T22:21:48Z",
    author: "aprlbrnl8-cyber",
    labels: [{ name: "bug", color: "d73a4a", description: "Something is not working" }],
    assignees: [],
    milestone: null,
    commentCount: 4,
  },
  {
    id: "preview-issue-2",
    host: "github.com",
    repository: "cli/cli",
    number: 14026,
    title: "Add repository-scoped All filtering for public repositories",
    url: "https://github.com/cli/cli/issues/14026",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-07-31T12:48:31Z",
    updatedAt: "2026-07-31T12:57:29Z",
    author: "williammartin",
    labels: [{ name: "enhancement", color: "0dd8ac", description: "A request to improve the CLI" }],
    assignees: ["cli-triage"],
    milestone: { title: "UI polish", number: 2, state: "OPEN", dueOn: null },
    commentCount: 7,
  },
  {
    id: "preview-issue-3",
    host: "github.com",
    repository: "cli/cli",
    number: 14015,
    title: "Long issue title demonstrates wrapping without hiding repository, state, author, or label metadata",
    url: "https://github.com/cli/cli/issues/14015",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-07-30T12:22:47Z",
    updatedAt: "2026-07-30T14:37:35Z",
    author: "jamietanna",
    labels: [
      { name: "enhancement", color: "0dd8ac", description: "A request to improve the CLI" },
      { name: "needs-investigation", color: "d45bd8", description: "CLI team needs to investigate" },
    ],
    assignees: [],
    milestone: null,
    commentCount: 12,
  },
  {
    id: "preview-issue-4",
    host: "github.com",
    repository: "cli/cli",
    number: 14009,
    title: "Markdown, code blocks, and timeline activity should remain readable in the expanded card",
    url: "https://github.com/cli/cli/issues/14009",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-07-29T19:57:46Z",
    updatedAt: "2026-07-30T13:09:51Z",
    author: "camchenry",
    labels: [{ name: "documentation", color: "0075ca", description: "Improvements to documentation" }],
    assignees: [],
    milestone: null,
    commentCount: 3,
  },
];

const bodies = {
  "preview-issue-1": `## Reproduction\n\nExpand the first issue while the other cards remain visible.\n\n- The selected card should have a clear accent.\n- The detail should appear directly below its card.\n- Other issue titles should remain easy to scan.`,
  "preview-issue-2": `## Expected behavior\n\nThe **All** view should use the repository selected by the workspace remote.\n\n\`\`\`text\nrepo:cli/cli is:open\n\`\`\``,
  "preview-issue-3": `## Why this fixture is long\n\nThis title intentionally wraps across lines so the metadata remains visible and the row height stays predictable.\n\n> The preview is local fixture data; it never calls GitHub.`,
  "preview-issue-4": `# Markdown preview\n\nA detail view should support **bold text**, \`inline code\`, and a short checklist.\n\n- Read the title\n- Expand the card\n- Collapse it again`,
};

const timelines = {
  "preview-issue-1": [
    { id: "preview-issue-1-comment", kind: "comment", type: "comment", actor: { login: "preview-user" }, createdAt: "2026-07-31T22:30:00Z", body: "The card remains visible while this detail is open." },
    { id: "preview-issue-1-label", kind: "label", type: "label", action: "labeled", actor: { login: "preview-user" }, label: { name: "bug", color: "d73a4a" }, createdAt: "2026-07-31T22:31:00Z" },
  ],
  "preview-issue-2": [
    { id: "preview-issue-2-state", kind: "state", type: "state", state: "open", actor: { login: "preview-user" }, createdAt: "2026-07-31T12:58:00Z" },
  ],
  "preview-issue-3": [
    { id: "preview-issue-3-assignment", kind: "assignment", type: "assignment", action: "assigned", actor: { login: "preview-user" }, assignee: { login: "cli-triage" }, createdAt: "2026-07-30T15:00:00Z" },
  ],
  "preview-issue-4": [
    { id: "preview-issue-4-comment", kind: "comment", type: "comment", actor: { login: "preview-user" }, createdAt: "2026-07-30T13:10:00Z", body: "The Markdown body and timeline use the same readable content width." },
  ],
};

export const details = Object.fromEntries(issues.map((issue) => [issue.id, {
  issue: { ...issue, body: bodies[issue.id] },
  timeline: { items: timelines[issue.id] || [], pageInfo: { hasNextPage: false, endCursor: null } },
  rateLimit,
  warnings: [],
}]));

export { rateLimit };
