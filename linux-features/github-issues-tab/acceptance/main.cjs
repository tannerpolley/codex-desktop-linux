"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "codex-issues-electron-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-gpu");
app.on("quit", () => fs.rmSync(profile, { recursive: true, force: true }));

async function waitFor(window, expression, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression, true)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 720,
    webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("console-message", (_event, ...args) => {
    const [details, legacyMessage] = args;
    const level = typeof details === "object" ? details.level : details;
    const message = typeof details === "object" ? details.message : legacyMessage;
    if (level === "error" || level === 3) errors.push(String(message));
  });
  window.webContents.on("render-process-gone", (_event, details) => errors.push(`renderer gone: ${details.reason}`));
  window.webContents.on("did-fail-load", (_event, code, description) => errors.push(`load failed ${code}: ${description}`));

  await window.loadFile(path.join(__dirname, "index.html"));
  await waitFor(window, 'document.querySelector("button[aria-label^=\\"Issue #\\"]") !== null', "the fixture issue list");
  await window.webContents.executeJavaScript('document.querySelector("button[aria-label^=\\"Issue #\\"]").click()');
  await waitFor(window, 'document.querySelector("section[aria-label=\\"Issue detail\\"] article h2")?.textContent.includes("issue rows should stay readable") === true', "the selected issue detail");
  await waitFor(window, 'document.querySelector("section[aria-label=\\"Issue timeline\\"]")?.textContent.includes("card remains visible") === true', "the issue timeline");
  if (errors.length > 0) throw new Error(`Renderer errors:\n${errors.join("\n")}`);
  console.log("GitHub Issues Electron acceptance passed: list, detail, timeline, no renderer errors");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
