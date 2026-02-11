---
name: opencode-plugin-architecture
description: Use when you need to understand the OpenCode plugin event lifecycle, session state transitions, and daemon API contracts
---

# OpenCode Plugin Architecture

## When To Use

Use this before changing plugin event handling or daemon payload contracts.

## Package

- `@pigeon/opencode-plugin`
- source and tests live in `packages/opencode-plugin`

## Core Lifecycle

1. Session created event initializes state.
2. Plugin registers main sessions with daemon (`/session-start`).
3. Message updates feed summary extraction.
4. Idle/stop events send final notification payload to daemon (`/stop`).

## Important Behavior

- head-first message capture for summary fidelity
- dedup to avoid repeated notifications
- environment detection for local transport metadata (nvim/tmux/tty)
- circuit-breaker around daemon HTTP calls

## Daemon Contracts

- `/session-start` payload includes session/process/transport context.
- `/stop` payload includes event + summary/message and label context.

## Verify

```bash
bun run --filter '@pigeon/opencode-plugin' test
bun run --filter '@pigeon/opencode-plugin' typecheck
```
