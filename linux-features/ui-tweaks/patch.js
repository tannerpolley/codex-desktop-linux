"use strict";

const sidebarProjectName = require("./patches/sidebar-project-name.js");
const uiFontSize = require("./patches/ui-font-size.js");
const skillMentionOrdering = require("./patches/skill-mention-ordering.js");
const modelPickerModelList = require("./patches/model-picker-model-list.js");
const reasoningEffortLabels = require("./patches/reasoning-effort-labels.js");
const dockIcon = require("./patches/dock-icon.js");
const suggestedPrompts = require("./patches/suggested-prompts.js");
const keepQuestionsOpen = require("./patches/keep-questions-open.js");
const linuxRevisionsBridge = require("./patches/linux-revisions-bridge.js");

function patchesFrom(...modules) {
  return modules.flatMap((moduleExports) =>
    Array.isArray(moduleExports?.descriptors) ? moduleExports.descriptors : [],
  );
}

module.exports = {
  descriptors: patchesFrom(
    sidebarProjectName,
    uiFontSize,
    skillMentionOrdering,
    modelPickerModelList,
    reasoningEffortLabels,
    dockIcon,
    suggestedPrompts,
    linuxRevisionsBridge,
    keepQuestionsOpen,
  ),
};
