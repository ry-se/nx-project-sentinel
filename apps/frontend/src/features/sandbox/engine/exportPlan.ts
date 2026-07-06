import type { ClassificationLevel, Provenance } from './classification';
import type { GeoPosition } from './geoFrame';
import {
  ALL_PHASES,
  type PlanFeature,
  type PlanFeatureType,
  readRangeFanSystemId,
} from './planFeature';
import type { Affiliation, Echelon } from './unitSymbol';

/** What export needs from a `Plan` (`planStore.ts`) — deliberately narrower than the full
 * `Plan` interface. The LIVE, not-yet-saved session (a `Sandbox.exportPlanGeoJSON` call
 * before any `savePlan`) has no real `id`/`anchor`/timestamps yet; requiring the full
 * `Plan` shape here would force fabricating placeholder values just to satisfy the type.
 * A saved `Plan` still satisfies this structurally, so both the live-session and the
 * saved-plan callers pass through the same functions unchanged. */
export interface ExportablePlan {
  name: string;
  features: PlanFeature[];
  classification: ClassificationLevel;
}

type GeoJSONGeometryType = 'Point' | 'LineString' | 'Polygon';

/** Every `PlanFeatureType`'s natural geometry shape (invariant 4), derived from what its
 * builder in `planFeature.ts` actually draws: `focus` is the one closed-area boundary tool
 * today (`buildFocusGroup`, ≥3 points); `objective`/`unit` are always single-point placements
 * (`buildObjectiveGroup`/`buildUnitSymbolGroup`) — the objective-AREA variant `planFeature.ts`
 * documents as "a later-wave refinement" does not exist yet, so `objective` maps to Point, not
 * Polygon. Every other type draws an open path (`arc`'s 3 points are center/radius/bearing
 * CONTROL points, not a swept wedge boundary — exported as the raw control-point path, per
 * invariant 1's "no re-projection"). `rangeFan` (todo 32) follows the SAME control-point
 * convention as `arc`: its 2 points (center, bearing) are exported as the raw path, NOT the
 * rendered annulus ring — reconstructing a true ring/hole GeoJSON Polygon from a system's
 * min/max range is out of this todo's scope (Wave 4 depth, not the export pipeline). */
const GEOMETRY_TYPE: Record<PlanFeatureType, GeoJSONGeometryType> = {
  distance: 'LineString',
  focus: 'Polygon',
  arc: 'LineString',
  los: 'LineString',
  boundary: 'LineString',
  phaseline: 'LineString',
  loa: 'LineString',
  axis: 'LineString',
  objective: 'Point',
  unit: 'Point',
  rangeFan: 'LineString',
};

type Coord3 = [number, number, number];

function toCoord(g: GeoPosition): Coord3 {
  return [g.lon, g.lat, g.altM];
}

interface GeometryData {
  type: GeoJSONGeometryType;
  /** Point: exactly 1 coordinate. LineString: the open path. Polygon: a CLOSED linear
   * ring (first coordinate repeated at the end, per RFC 7946 §3.1.6 / KML LinearRing). */
  coords: Coord3[];
}

/** Reads `PlanFeature.points.geo` only — no re-projection, no re-derivation from `local`
 * (invariant 1). Closes the ring for `Polygon` types if the draft didn't already. */
function geometryData(pf: PlanFeature): GeometryData {
  const coords = pf.points.geo.map(toCoord);
  const type = GEOMETRY_TYPE[pf.type];
  if (type !== 'Polygon' || coords.length < 2) return { type, coords };
  const [first] = coords;
  const last = coords[coords.length - 1];
  const closed = first[0] === last[0] && first[1] === last[1] && first[2] === last[2];
  return { type, coords: closed ? coords : [...coords, first] };
}

/** Classification + provenance (todo 22) travel into every exported feature's properties —
 * the marked product stays marked on hand-off (invariant 3). */
function featureProperties(
  pf: PlanFeature,
  classification: ClassificationLevel
): Record<string, unknown> {
  const props: Record<string, unknown> = { name: pf.name, type: pf.type, classification };
  const provenance = pf.metadata.provenance as Provenance | undefined;
  if (provenance) props.provenance = provenance;
  // Phase tag (todo 25 invariant 4) — omitted for an untagged/all-phase feature, matching
  // the `provenance`-optional convention above (no noise for the common untagged case).
  const phase = pf.metadata.phase;
  if (typeof phase === 'string' && phase !== ALL_PHASES) props.phase = phase;
  if (pf.type === 'unit') {
    props.affiliation = pf.metadata.affiliation as Affiliation | undefined;
    props.echelon = pf.metadata.echelon as Echelon | undefined;
  }
  if (pf.type === 'rangeFan') {
    props.systemId = readRangeFanSystemId(pf.metadata);
  }
  return props;
}

/** A `FeatureCollection` (RFC 7946 §3.3) — one Feature per `PlanFeature`, geometry per
 * `GEOMETRY_TYPE`, properties per `featureProperties`. */
export function exportGeoJSON(plan: ExportablePlan): string {
  const featureCollection = {
    type: 'FeatureCollection',
    features: plan.features.map((pf) => {
      const geom = geometryData(pf);
      const coordinates = geom.type === 'Point' ? geom.coords[0] : geom.coords;
      return {
        type: 'Feature',
        geometry: {
          type: geom.type,
          coordinates: geom.type === 'Polygon' ? [coordinates] : coordinates,
        },
        properties: featureProperties(pf, plan.classification),
      };
    }),
  };
  return JSON.stringify(featureCollection, null, 2);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function kmlGeometry(geom: GeometryData): string {
  const coordText = geom.coords.map((c) => c.join(',')).join(' ');
  if (geom.type === 'Point') return `<Point><coordinates>${coordText}</coordinates></Point>`;
  if (geom.type === 'Polygon') {
    return (
      '<Polygon><outerBoundaryIs><LinearRing>' +
      `<coordinates>${coordText}</coordinates>` +
      '</LinearRing></outerBoundaryIs></Polygon>'
    );
  }
  return `<LineString><coordinates>${coordText}</coordinates></LineString>`;
}

/** Flattens a properties object (which may nest `provenance`) into `name`/`value` pairs
 * for KML `<ExtendedData>` — `name` itself is excluded, since it becomes the Placemark's
 * `<name>` element instead. */
function flattenProperties(props: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(props)) {
    if (key === 'name' || value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        out.push([`${key}_${subKey}`, String(subValue)]);
      }
    } else {
      out.push([key, String(value)]);
    }
  }
  return out;
}

/** Equivalent KML (invariant 2 — well-formed XML) — one `Placemark` per `PlanFeature`,
 * so a plan opens directly in Google Earth for a briefing hand-off (D-Army-4(a)). */
export function exportKML(plan: ExportablePlan): string {
  const placemarks = plan.features
    .map((pf) => {
      const props = featureProperties(pf, plan.classification);
      const extendedData = flattenProperties(props)
        .map(
          ([key, value]) =>
            `<Data name="${xmlEscape(key)}"><value>${xmlEscape(value)}</value></Data>`
        )
        .join('');
      return (
        '<Placemark>' +
        `<name>${xmlEscape(pf.name)}</name>` +
        `<ExtendedData>${extendedData}</ExtendedData>` +
        kmlGeometry(geometryData(pf)) +
        '</Placemark>'
      );
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<kml xmlns="http://www.opengis.net/kml/2.2">' +
    `<Document><name>${xmlEscape(plan.name)}</name>${placemarks}</Document>` +
    '</kml>'
  );
}
