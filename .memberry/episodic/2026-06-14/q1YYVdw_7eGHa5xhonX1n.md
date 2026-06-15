---
id: q1YYVdw_7eGHa5xhonX1n
session_id: session-20260613-tui
agent_id: default
task: Build @ap3x/tui terminal UI library (clean-room reimplementation of pi-tui)
outcome: approved
created_at: "2026-06-14T05:30:15.047Z"
---

Implemented @ap3x/tui (AP3X's rich-equivalent terminal UI). Key decisions: (1) Zero npm deps — hand-rolled an East-Asian-width range table (east-asian-width.ts) to replace get-east-asian-width, and a CommonMark-subset markdown lexer to replace `marked`. Native Intl.Segmenter for graphemes. (2) AP3X convention is EXTENSIONLESS relative imports (./foo not ./foo.ts) — upstream pi-tui used .ts extensions which fail under bundler resolution without allowImportingTsExtensions. (3) The RGI_Emoji regex needs the `v` flag (es2024); used new RegExp(...,"v") + biome-ignore useRegexLiterals, and set the tui tsconfig lib=ES2024 (kept target inherited ES2022 so esbuild/tsup don't warn). (4) Brand scrub: CURSOR_MARKER=\x1b_ap3x:c\x07, env vars AP3X_HARDWARE_CURSOR/AP3X_CLEAR_ON_SHRINK/AP3X_DEBUG_REDRAW/AP3X_TUI_DEBUG/AP3X_TUI_WRITE_LOG, log paths ~/.ap3x/tui/. (5) biome flags \x1b in regex literals (noControlCharactersInRegex) — added targeted biome-ignore comments; this is inherent to terminal code. (6) Swarms-facing panels (printStreamingPanel/printThinkingPanel/loadingStatus) are AP3X-new (not in pi-tui); built fresh against a PanelWriter sink. Deferred: native addons (graceful pure-JS fallback) and the Image component (terminal-image encoders kept). 85 tui tests + 265 total pass; tsc/biome/contamination/build all exit 0.