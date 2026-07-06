# Spec — Strategist Tools: UI Design System

Part of the strategist-tools domain — see `strategist-tools.md` for the full file map.
Covers the panel-rail design system shared by strategist mode AND player mode. Sources:
`styles.css`, `ui/PanelRail.tsx`, `ui/PanelSection.tsx`.

## Strategist UI design system (`styles.css`, `ui/PanelRail.tsx`, `ui/PanelSection.tsx`)

A dark "sentinel" daisyUI theme (`styles.css`) — one reserved cyan accent
(`--color-primary`/`secondary`/`accent`, mapped identically so no daisyUI component
defaults to a different brand color) drives every interactive/selected state; dark
blue-grey surfaces; sharper corners than daisyUI's stock defaults. Classification colors
(`classification.ts`'s `CLASSIFICATION_COLOR`) are NEVER drawn from these theme tokens —
they stay inline `style={{backgroundColor}}`, reserved for classification alone, so the
banner's meaning can never silently drift with a future theme change. `lucide-react` icons
replace every button emoji except the Tank vehicle icon (no clear lucide equivalent) and
unrelated Spider-Man-mode status text (out of this workstream's scope).

Every strategist/player-mode side panel is a child of ONE `PanelRail` per side
(`ui/PanelRail.tsx`) — a docked, scrollable glass surface whose real CSS flow resolves
position/height, replacing what used to be N independently `fixed`-positioned panels each
guessing a hardcoded left offset (the concrete bug this fixed: the Plans panel at
`left-[28rem]` and the Brief-sequence panel at `left-[34rem]` genuinely overlapped for
6rem, because neither offset accounted for the other's rendered width). Inside the
strategist-mode left rail, `PanelSection` (`ui/PanelSection.tsx`) wraps each of Tools,
Features, Plans, and Brief sequence as a collapsible section (defaults expanded — every
panel's prior always-visible behavior is unchanged), ordered top-to-bottom as one workflow:
draw/measure → see what you drew → persist it as a named plan → sequence a briefing
walkthrough — rather than the arbitrary prior source order. The player-mode vehicle
switcher and the right-side camera-pose/capture/import-intel block each get their own
single-section `PanelRail` (no `PanelSection` needed — each was already one self-contained
block with nothing to merge).
