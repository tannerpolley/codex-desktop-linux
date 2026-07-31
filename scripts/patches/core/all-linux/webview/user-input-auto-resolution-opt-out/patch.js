"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxUserInputAutoResolutionOptOutPatch,
} = require("../../../../impl/webview/index.js");

module.exports = webviewAssetPatch({
  id: "linux-user-input-auto-resolution-opt-out",
  phase: "webview-asset",
  order: 1071,
  ciPolicy: "optional",
  pattern: /^app-initial-[^.]+\.js$/,
  missingDescription: "request input webview bundle",
  skipDescription: "Linux request input auto-resolution opt-out patch",
  apply: applyLinuxUserInputAutoResolutionOptOutPatch,
});
