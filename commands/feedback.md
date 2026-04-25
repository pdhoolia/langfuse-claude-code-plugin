---
description: Record thumbs-up/down feedback on the most recent completed turn
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: up|down [optional comment]
---

!`node "${CLAUDE_PLUGIN_ROOT}/bundle/commands/feedback.js" $ARGUMENTS`
