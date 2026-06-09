---
id: OUZm1-lyioyef8FlBk8Mr
session_id: session-20260609-audit
agent_id: default
task: Audit Call Intake drop-in files for Rails portal parity (slice call-intake)
created_at: "2026-06-09T08:12:01.441Z"
---

BLOCKING bug found in Zportal Rails drop-in rails/app/javascript/call_tools/call_intake_form.js: the file was copied from the standalone preview (assets/call_intake_form.js) but only half-converted to an ES module. It still opens the IIFE wrapper `(function () {` at line 11, places `export function mount(root) {` at line 148 (illegal: export cannot appear inside a function body), and never closes the IIFE (no `})();` and no `window.CallIntakeForm = {...}` at the end; file just ends at line 257 with mount's closing brace). Result: SyntaxError at module parse time -> importmap resolution of `call_tools/call_intake_form` fails -> `import { mount }` in controllers/call_intake_controller.js fails -> Stimulus controller never connects -> empty mount div. Fix: delete the IIFE wrapper line 11 and de-indent the body; keep `export function mount(root)` at top level; drop the preview-only window.CallIntakeForm bootstrap. Logic body is otherwise byte-identical to the preview (verified via diff). Stimulus wiring is correct: HAML show.haml sets data-controller="call-intake" and data-call-intake-target="mount", matching static targets=["mount"] / this.mountTarget. CSS properly namespaced under .call-tool; uses local .ct-btn (not portal .btn globals); header uses btn btn--secondary correctly.