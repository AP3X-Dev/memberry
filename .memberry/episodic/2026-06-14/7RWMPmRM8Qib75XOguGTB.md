---
id: 7RWMPmRM8Qib75XOguGTB
session_id: session-20260613-210500
agent_id: default
task: Build provider adapters for @ap3x/ai (clean-room reimplementation from pi-ai)
outcome: approved
created_at: "2026-06-14T04:36:36.067Z"
---

Implemented the full provider-adapter layer for @ap3x/ai using native fetch + manual SSE parsing (no vendor SDKs, since none are deps). Key decisions:
- Built a shared streaming skeleton (providers/provider-runtime.ts: runStream/freshAssistantMessage/stripScratchFields/pushDone/toProviderResponse) and a shared SSE decoder (utils/sse.ts: iterateServerSentEvents + parseServerSentEventsFromString) to eliminate the duplicated fire-and-forget IIFE across adapters (an Improvement the P2 spec flagged).
- Consolidated tool-call-id rules into one policy module (providers/tool-call-id.ts) keyed by target (anthropic≤64 / openai-completions≤40 / openai-responses call_id|item_id with fc_ + foreign hash / mistral exactly 9 via createMistralToolCallIdNormalizer / bedrock+google≤64). Another flagged Improvement.
- Anthropic + OpenAI completions + OpenAI responses(+azure+codex) implemented fully with stream parsing. Google/Vertex via REST streamGenerateContent?alt=sse. Mistral via OpenAI-compatible /v1/chat/completions. Bedrock is Node-only/injectable: pure convertMessages/buildConverseRequest/processBedrockStream + setBedrockProviderModule (accepts createTransport or streamBedrock override); errors clearly when no transport injected.
- Branding scrub: env var renamed PI_CACHE_RETENTION -> AP3X_CACHE_RETENTION; Codex originator "ap3x" (not "pi"); responses fallback id prefix msg_ap3x_ (not msg_pi_); no telemetry. Contamination scan exits 0 (92 terms).
- Deferred (noted in code): OAuth (Anthropic/Copilot/Codex), Codex WebSocket transport + account-id extraction, Vertex ADC ambient creds, Bedrock SigV4, image generation.

Results: npm run check exits 0 (biome + tsc strict over 85 files); npm test 122/122 pass (57 in @ap3x/ai: 35 new + 22 existing); tsup build green (ESM + DTS). Added tests: tool-call-id policy, transformMessages normalization, per-provider request shapes, canned-SSE/event stream parsing (Anthropic via mocked fetch, Responses + Bedrock via exported processors), registerBuiltInApiProviders. COVERAGE.md Phase B flipped: all 7 provider rows + transformMessages + tool-call-id + AP3X_CACHE_RETENTION/no-telemetry to [x]; image generation left unchecked.