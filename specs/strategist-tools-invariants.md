# Spec — Strategist Tools: Invariants (do not regress)

Part of the strategist-tools domain — see `strategist-tools.md` for the full file map.
Cross-cutting properties every tool in `strategist-tools-foundation.md`,
`strategist-tools-briefing.md`, `strategist-tools-rehearsal.md`, and
`strategist-tools-terrain-analysis.md` MUST hold. This file is the single canonical
location for "what must never break" across the whole domain — individual sub-files
document their OWN tool-specific invariants inline; this file holds the ones that apply
domain-wide.

## Invariants (do not regress)

- Strategist overlay features render on layer 1 and MUST stay out of the viewshed depth
  pass (which renders layer 0 only).
- The viewshed depth map MUST be re-rendered per frame while active (correctness as
  tiles stream).
- LOS far is `dist − 2 m` so the endpoint marker is never self-blocking.
- Every feature MUST round-trip through `PlanFeature`: `rebuildFeature(serializeFeature(...))`
  renders an equivalent group (same points, same label text) for all current types.
  Persistence, export, and phasing all read this one representation — a tool that renders
  directly without producing a `PlanFeature` is the bug that breaks save/export/phase
  silently.
- `PlanFeature.points.geo` is captured at draw time (`geoFrame.localToGeo`), never
  recomputed on load.
- Any defensive metadata-whitelist check (e.g. `readUnitMetadata`, `readRangeFanSystemId`,
  `resolveFeaturePhase`) MUST use `Object.prototype.hasOwnProperty.call(table, key)`, NOT
  the `in` operator — `in` walks the prototype chain and matches inherited
  `Object.prototype` keys (`"toString"`, `"constructor"`, ...), letting corrupted/hand-edited
  saved data resolve to an inherited function instead of falling back to a safe default
  (security-review finding, Wave 4).
