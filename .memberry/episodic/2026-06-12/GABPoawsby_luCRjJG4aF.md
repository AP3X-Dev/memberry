---
id: GABPoawsby_luCRjJG4aF
session_id: session-20260612-104500
agent_id: default
task: Add Sentry.io crash/error reporting to the CIC Assistant Electron app
outcome: approved
created_at: "2026-06-12T19:02:57.224Z"
---

Wired Sentry into the Electron app (commit ebb9d94). Main process: @sentry/electron/main init at top of main.js — after the userData re-path (so Sentry's offline cache lands under cic-assistant) and before app ready (so PreloadInjection registers the renderer IPC bridge + native crash handler). DSN hardcoded in source: Sentry DSNs are public client identifiers, not covered by the AI-keys-off-disk guardrail. environment=production/development via app.isPackaged, release=cic-assistant@version. Renderer decision: no bundler exists and CSP is script-src 'self' with sandbox:true, and @sentry/electron v7 ships no IIFE bundle (npm or GitHub releases) — so we vendor an esbuild-generated IIFE bundle at src/electron/renderer/vendor/sentry-electron-renderer.js (regenerate with `npm run build:sentry-renderer` after upgrading @sentry/electron; esbuild added as devDependency). Guarded sentry-init.js inits with no options (config inherits from main over classic IPC via window.__SENTRY_IPC__, no CSP change needed). Renderer script tags are additive instrumentation — backend contract untouched. Sentry's OnUncaughtException integration only captures+flushes; logger.js's existing uncaughtException handler keeps the app's crash semantics. Verified: smoke event delivered (flush=true) under Electron 41, full app boot clean, renderer alive. Known flake: tests/test_import_speed.py fails when the machine is CPU-pegged (scribo-v2 at 99% load) — wall-clock benchmark, not a code regression.