"use strict";

const OPERATIONS = new Set(["capabilities", "listIssues", "getIssue", "getIssueTimelinePage", "cancel"]);
const VIEWS = new Set(["assigned", "authored", "all"]);
const STATES = new Set(["open", "closed", "all"]);
const LIMITS = Object.freeze({ requestId: 96, host: 253, repository: 200, text: 500, cursor: 512, nodeId: 256 });

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object with a plain prototype`);
}

function assertKnownFields(value, allowed) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`unknown field: ${String(key)}`);
    }
  }
}

function assertString(value, field, limit, { nonEmpty = true } = {}) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  if (nonEmpty && value.length === 0) throw new TypeError(`${field} must not be empty`);
  if (value.length > limit) throw new RangeError(`${field} too long (maximum ${limit})`);
  if (CONTROL_CHARACTERS.test(value)) throw new TypeError(`${field} contains a control character`);
}

function assertOptionalString(value, field, limit, { nonEmpty = true } = {}) {
  if (value === null) return;
  assertString(value, field, limit, { nonEmpty });
}

function assertEnum(value, field, values) {
  if (typeof value !== "string" || !values.has(value)) {
    throw new TypeError(`invalid ${field}`);
  }
}

function assertHostname(value, field = "host", { nullable = false } = {}) {
  if (nullable && value === null) return;
  assertString(value, field, LIMITS.host, { nonEmpty: false });
  if (value.length === 0 || value.length > LIMITS.host || value.endsWith(".") || value.includes("..")) {
    throw new TypeError(`invalid hostname: ${field}`);
  }
  const labels = value.split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) throw new TypeError(`invalid hostname: ${field}`);
}

function assertRepository(value, field = "repository") {
  if (value === null) return;
  assertString(value, field, LIMITS.repository);
  const separator = value.indexOf("/");
  if (separator <= 0 || separator !== value.lastIndexOf("/") || separator === value.length - 1) {
    throw new TypeError(`invalid repository: ${field}`);
  }
  const [owner, name] = value.split("/");
  if (!REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) {
    throw new TypeError(`invalid repository: ${field}`);
  }
}

function requireField(value, field) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) throw new TypeError(`missing field: ${field}`);
}

function validateHostInput(input, { nullable = false } = {}) {
  requireField(input, "host");
  assertHostname(input.host, "host", { nullable });
}

function validateListInput(input) {
  assertKnownFields(input, new Set(["host", "view", "state", "repository", "text", "cursor"]));
  for (const field of ["host", "view", "state", "repository", "text", "cursor"]) requireField(input, field);
  validateHostInput(input);
  assertEnum(input.view, "view", VIEWS);
  assertEnum(input.state, "state", STATES);
  assertRepository(input.repository);
  assertString(input.text, "text", LIMITS.text, { nonEmpty: false });
  assertOptionalString(input.cursor, "cursor", LIMITS.cursor);
}

function validateIssueInput(input, { timeline = false } = {}) {
  const fields = timeline ? ["host", "nodeId", "cursor"] : ["host", "nodeId"];
  assertKnownFields(input, new Set(fields));
  for (const field of fields) requireField(input, field);
  validateHostInput(input);
  assertString(input.nodeId, "nodeId", LIMITS.nodeId);
  if (timeline) assertString(input.cursor, "cursor", LIMITS.cursor);
}

function validateInput(operation, input) {
  assertRecord(input, "input");
  switch (operation) {
    case "capabilities":
      assertKnownFields(input, new Set(["host"]));
      validateHostInput(input, { nullable: true });
      break;
    case "listIssues":
      validateListInput(input);
      break;
    case "getIssue":
      validateIssueInput(input);
      break;
    case "getIssueTimelinePage":
      validateIssueInput(input, { timeline: true });
      break;
    case "cancel":
      assertKnownFields(input, new Set(["targetRequestId"]));
      requireField(input, "targetRequestId");
      assertString(input.targetRequestId, "targetRequestId", LIMITS.requestId);
      break;
    default:
      throw new TypeError(`invalid operation: ${operation}`);
  }
}

function cloneInput(operation, input) {
  switch (operation) {
    case "capabilities":
      return { host: input.host };
    case "listIssues":
      return {
        host: input.host,
        view: input.view,
        state: input.state,
        repository: input.repository,
        text: input.text,
        cursor: input.cursor,
      };
    case "getIssue":
      return { host: input.host, nodeId: input.nodeId };
    case "getIssueTimelinePage":
      return { host: input.host, nodeId: input.nodeId, cursor: input.cursor };
    case "cancel":
      return { targetRequestId: input.targetRequestId };
    default:
      throw new TypeError(`invalid operation: ${operation}`);
  }
}

function validateEnvelope(value) {
  assertRecord(value, "envelope");
  assertKnownFields(value, new Set(["version", "requestId", "operation", "input"]));
  for (const field of ["version", "requestId", "operation", "input"]) requireField(value, field);
  if (value.version !== 1) throw new TypeError("version must be 1");
  assertString(value.requestId, "requestId", LIMITS.requestId);
  assertEnum(value.operation, "operation", OPERATIONS);
  validateInput(value.operation, value.input);
  return {
    version: 1,
    requestId: value.requestId,
    operation: value.operation,
    input: cloneInput(value.operation, value.input),
  };
}

function cloneResponseData(value) {
  if (Array.isArray(value)) return value.map(cloneResponseData);
  if (isRecord(value)) return Object.fromEntries(Reflect.ownKeys(value).map((key) => {
    if (typeof key !== "string") throw new TypeError(`response data has unsupported field: ${String(key)}`);
    return [key, cloneResponseData(value[key])];
  }));
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new TypeError("response data must contain JSON values");
}

function validateResponse(value) {
  assertRecord(value, "response");
  assertKnownFields(value, new Set(["version", "requestId", "ok", "data", "error"]));
  for (const field of ["version", "requestId", "ok", "data", "error"]) requireField(value, field);
  if (value.version !== 1) throw new TypeError("version must be 1");
  assertString(value.requestId, "requestId", LIMITS.requestId);
  if (typeof value.ok !== "boolean") throw new TypeError("ok must be a boolean");
  if (value.ok) {
    if (value.error !== null) throw new TypeError("successful response error must be null");
    if (value.data === undefined) throw new TypeError("successful response data is required");
  } else {
    if (value.data !== null) throw new TypeError("failed response data must be null");
    assertRecord(value.error, "error");
    assertKnownFields(value.error, new Set(["code", "message"]));
    requireField(value.error, "code");
    requireField(value.error, "message");
    assertString(value.error.code, "error.code", 64);
    assertString(value.error.message, "error.message", 500);
  }
  return {
    version: 1,
    requestId: value.requestId,
    ok: value.ok,
    data: value.data === null ? null : cloneResponseData(value.data),
    error: value.error === null ? null : { code: value.error.code, message: value.error.message },
  };
}

module.exports = {
  OPERATIONS,
  VIEWS,
  STATES,
  LIMITS,
  validateEnvelope,
  validateResponse,
};
