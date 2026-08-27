"use strict";

const OPERATIONS = new Set(["capabilities", "listIssues", "getIssue", "cancel"]);
const VIEWS = new Set(["all", "assigned", "authored"]);
const STATES = new Set(["open", "closed", "all"]);

function text(value, name, max = 500, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`invalid ${name}`);
  }
}

function validateEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid request");
  text(value.requestId, "requestId", 96);
  if (value.version !== 1 || !OPERATIONS.has(value.operation) || value.input === null || typeof value.input !== "object" || Array.isArray(value.input)) {
    throw new TypeError("invalid request");
  }
  const input = value.input;
  if (value.operation === "capabilities") text(input.host, "host", 253, true);
  if (value.operation === "listIssues") {
    text(input.host, "host", 253);
    if (!VIEWS.has(input.view) || !STATES.has(input.state)) throw new TypeError("invalid filter");
    if (input.repository !== null) text(input.repository, "repository", 200);
    if (typeof input.query !== "string" || input.query.length > 500) throw new TypeError("invalid query");
    if (input.cursor !== null) text(input.cursor, "cursor", 512);
  }
  if (value.operation === "getIssue") {
    text(input.host, "host", 253);
    text(input.nodeId, "nodeId", 256);
  }
  if (value.operation === "cancel") text(input.targetRequestId, "targetRequestId", 96);
  return { version: 1, requestId: value.requestId, operation: value.operation, input: { ...input } };
}

module.exports = { OPERATIONS, STATES, VIEWS, validateEnvelope };
