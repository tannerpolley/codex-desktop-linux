"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

function productionSettingsModule() {
  const extracted = process.env.CODEX_EXTRACTED_APP_DIR;
  if (!extracted) throw new Error("CODEX_EXTRACTED_APP_DIR is required");
  const assets = path.join(extracted, "webview", "assets");
  const names = fs.readdirSync(assets).filter((name) => name.endsWith(".js"));
  const patched = names.find((name) => fs.readFileSync(path.join(assets, name), "utf8").includes("codexLinuxRevisionsSettings"));
  if (!patched) throw new Error("Patched Linux revisions settings module was not found");
  const wrapper = names.find((name) => {
    const source = fs.readFileSync(path.join(assets, name), "utf8");
    return source.includes(`from\"./${patched}\"`) && source.includes("GeneralSettings");
  });
  if (!wrapper) throw new Error("Production GeneralSettings wrapper was not found");
  return pathToFileURL(path.join(assets, wrapper)).href;
}

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  window.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message); });
  await window.loadFile(path.join(__dirname, "index.html"));
  const result = await window.webContents.executeJavaScript(`import(${JSON.stringify(productionSettingsModule())}).then(module=>typeof module.GeneralSettings)`);
  if (result !== "function") throw new Error(`GeneralSettings export is ${result}`);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Linux revisions Settings module acceptance passed");
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
