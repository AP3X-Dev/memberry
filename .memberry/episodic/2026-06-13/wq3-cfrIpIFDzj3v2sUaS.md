---
id: wq3-cfrIpIFDzj3v2sUaS
session_id: session-20260613-ag3ntic-morph
agent_id: default
task: Reskin /skills gap page into AG3NTIC UI2 design language
outcome: approved
created_at: "2026-06-13T09:45:07.694Z"
---

Reskinned app/(app)/skills/page.tsx into AG3NTIC UI2. Skills is a "gap" page (folded under Tools&Skills in the DC, no dedicated mock) but holds the REAL skills catalog data, so it was kept with all queries/behavior. Preserved 100% behavior: useQuery key ["skills", ws] hitting /workspaces/${ws}/skills returning {skills, count}; the Skill type (slug, name, category?, summary?, instructions?, required_capability_slugs[], status); and the click-to-expand inline playbook (instructions) toggle. Replaced the old design system (--line/--bg-2/--fg-2/var(--r-md)/var(--font-display)/.chip/.mono, PageHead/EmptyState/ErrorState/SkeletonRows/StatusBadge from @/components/ui) with UI2 inline-styled cards: 14px radius, --card/--bd, neutral book glyph chip (--card2), status dot (teal=active/ready, amber=draft/degraded, red=failed, else --txt3), mono slug·category meta, mono pinned-tool chips, teal --ac2 "View/Hide playbook" toggle revealing a mono pre. data-m hooks: outer wrapper data-m="page" padding 34px 40px 48px maxWidth 1322 margin auto; data-m="phead" header; grids data-m="g3". Grid uses repeat(auto-fill,minmax(310px,1fr)). Inlined ErrorPanel (mirrors tools/[slug] pattern) since UI2 pages drop the ui.tsx state components. Compile-clean: full tsc --noEmit passed. Only the one page file was touched.