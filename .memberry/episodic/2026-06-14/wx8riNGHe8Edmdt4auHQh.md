---
id: wx8riNGHe8Edmdt4auHQh
session_id: session-20260614-022700
agent_id: default
task: Implement @ap3x/ai OAuth + image generation (unit B3)
outcome: approved
created_at: "2026-06-14T09:32:17.346Z"
---

Completed @ap3x/ai unit B3: OAuth + image generation, both deferred from the providers phase.

OAuth (packages/ai/src/auth/): AuthStorage persists tokens per-provider to ~/.ap3x/oauth.json (AP3X_CONFIG_DIR override; mode 0600; in-memory variant for tests). PKCE S256 hand-rolled with node:crypto (no new dep). One parameterized flow set in oauth-flow.ts (buildAuthorizationUrl + exchangeAuthorizationCode for auth-code+PKCE; startDeviceAuthorization + pollDeviceToken for device flow handling authorization_pending/slow_down/access_denied/expired; refreshAccessToken with refresh-token carry-forward). Three providers are config records in providers.ts (Anthropic=auth-code, GitHub Copilot=device, OpenAI Codex=auth-code), NOT three copy-pasted flows.

CRITICAL DESIGN: client IDs are configurable — resolved via explicit override -> AP3X_<PROVIDER>_OAUTH_CLIENT_ID env -> AP3X-owned placeholder default (e.g. "ap3x-anthropic-oauth"). Never a vendor's registered id.

Unified seam #38: getApiKeyAndHeaders(model, opts) in unified.ts returns ResolvedAuth {mode:oauth|api-key|none, headers, apiKey}. Resolution: stored OAuth token (auto-refreshed via injectable fetchImpl when expired/near-expiry, then persisted) -> explicit apiKey -> env apiKey -> none. Anthropic OAuth uses Authorization: Bearer + anthropic-beta oauth-2025-04-20; api-key uses x-api-key; other providers use Bearer. All token/device HTTP goes through an injectable FetchLike (default globalThis.fetch).

Wired OAuth bearer into anthropic.ts (new AnthropicOptions.oauthToken; buildHeaders sends Authorization+OAUTH_BETA when set, skips x-api-key; streamAnthropic allows oauthToken without apiKey). Codex already used bearer apiKey; updated its deferred comment.

Images (#36): generateImages facade in images.ts (never throws; accepts ImagesContext or bare prompt string). Parallel registries: images-registry.ts (provider) + images-models.ts (IMAGE_MODELS: openai/gpt-image-1, google/imagen-3). TypeBox request schema in images-schema.ts (parseImageGenerationRequest, defaults+validation). Providers: openai-images.ts (/v1/images/generations, b64_json), google-images.ts (Imagen :predict), faux-images.ts (deterministic double mirroring faux.ts, FAUX_PNG_BASE64). register-images.ts registers openai-images + google-images on facade import. Added openai-images/google-images/faux-images to KnownImagesApi and openai/google/faux to KnownImagesProvider in types.ts.

All exported from index.ts. Tests: oauth.test.ts (22) + images.test.ts (11) + 1 new anthropic OAuth-bearer test. Gotcha: verbatimModuleSyntax requires import type; noUncheckedIndexedAccess needs guarded index access; biome noDelete needs biome-ignore for env-var deletes in tests.

GATES (all exit 0): npm run check, npm test (47 files / 624 tests, was 540 baseline; +33 mine), contamination-scan (92 terms clean), npm run build (all packages) + build -w @ap3x/ai. COVERAGE.md Phase B flipped: facade, OAuth line, Image generation line, plus Anthropic/OpenAI-responses provider rows updated. Did NOT commit. Touched only packages/ai/ + clean-room/COVERAGE.md.