---
description: Record thumbs-up/down feedback on the entire current session
disable-model-invocation: true
allowed-tools: Bash(node:*)
argument-hint: up|down [optional comment]
---

!`node "${CLAUDE_PLUGIN_ROOT}/bundle/commands/journey.js" $ARGUMENTS`
