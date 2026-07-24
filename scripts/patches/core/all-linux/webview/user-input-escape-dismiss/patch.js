"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxUserInputEscapeDismissPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-user-input-escape-dismiss",
  phase: "webview-asset",
  order: 1070,
  ciPolicy: "optional",
  pattern: /^app-initial-[^.]+\.js$/,
  missingDescription: "request input webview bundle",
  skipDescription: "Linux request input escape-dismiss patch",
  apply: applyLinuxUserInputEscapeDismissPatch,
});
