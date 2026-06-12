---
id: tkcp0NUIR5j4KpdQFU-Oj
session_id: session-20260611-ag3ntic-morph
agent_id: default
task: Build the ag3ntic-browser capability (browser_worker) end to end
created_at: "2026-06-12T02:22:51.300Z"
---

Built the real `browser` capability on branch morph/browser-capability (off main). Spec: docs/superpowers/specs/2026-06-11-ag3ntic-browser-capability-design.md; plan: docs/superpowers/plans/2026-06-11-ag3ntic-browser-capability.md.

DONE + full suite green (1088 passed):
- P1 Manifest: reshaped BrowserWorkerRuntime to a per-workspace sidecar shape (optional image/image_digest/internal_port=9300/endpoints, enforced at launch; pooled fields kept optional so old tests stay valid), added _endpoints_cover_actions validator to BrowserWorkerManifest, reshaped browser.capability.yaml runtime to image+endpoints.
- P2 Config/seed: added settings.browser_capability_image[_digest]; registered browser in seed._SEED_IMAGE_DIGEST_SETTINGS (env BROWSER_CAPABILITY_IMAGE_DIGEST; seeds unpinned until set, like notes_mcp).
- P3 Wiring: browser_worker added to sidecars.CONTAINER_BACKED_TYPES; launcher isinstance accepts BrowserWorkerManifest; shim bind_backing_request 'computer' branch extended to ('computer','browser_worker') so actions dispatch to http://mcp-<ws>-browser:9300 via endpoints (no browser-specific path).
- P4 Image: new runtimes/browser-worker/ — Playwright+FastAPI backend (browse_url/extract_content/search_web via real headless nav to the no-auth DuckDuckGo HTML endpoint/download_file on :9300), SSRF egress guard (blocks private/loopback/link-local/metadata IPs), per-run browser contexts; Dockerfile on mcr.microsoft.com/playwright/python:v1.49.1-jammy. Egress + search-parser unit tests pass locally; handler tests run in-image.
- P6 Operator default: prompt.py now steers the Operator to prefer `browser` for web work, reserve `computer` for desktop/GUI.

PENDING (need user decision):
- P5 download_file → durable storage: the existing `artifacts` table is REVISION-scoped (unique on revision_id+kind) so it does NOT fit run-scoped downloads. files/storage.py has a clean async put_object(key,data,content_type) on MinIO. Options: (A) new downloads/run_files table + Alembic migration + put_object, return ref (console-listable); (B) object-store-only ref via put_object, no DB row/migration (quick, functional, no console listing); (C) defer download_file. Currently the worker returns content_b64 inline (not yet persisted by the shim).
- P7 deploy: not started — building the Playwright image on Cerebro, pin BROWSER_CAPABILITY_IMAGE_DIGEST in infra/images.lock.env, recreate api/worker, re-seed, live-verify via the manifest test_task. Deferred pending explicit go-ahead (user said implement on branch, not deploy).