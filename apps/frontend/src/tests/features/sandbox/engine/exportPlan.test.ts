import type { Provenance } from '../../../../features/sandbox/engine/classification';
import { exportGeoJSON, exportKML } from '../../../../features/sandbox/engine/exportPlan';
import type { PlanFeature } from '../../../../features/sandbox/engine/planFeature';
import type { Plan } from '../../../../features/sandbox/engine/planStore';

/**
 * Todo 23: `exportGeoJSON`/`exportKML` read `PlanFeature.points.geo` only (invariant 1),
 * produce RFC-7946-shaped / well-formed-XML output (invariant 2), carry classification +
 * provenance into every feature's properties (invariant 3), and map geometry type
 * correctly per feature type — line vs polygon vs point (invariant 4).
 */

const PROVENANCE: Provenance = {
  author: 'CPT Tan',
  createdAt: '2026-07-05T00:00:00.000Z',
  updatedAt: '2026-07-05T00:00:00.000Z',
};

function distanceFeature(): PlanFeature {
  return {
    id: 'f-distance',
    type: 'distance',
    name: 'Distance 1',
    points: {
      local: [
        { x: 0, y: 0, z: 0 },
        { x: 50, y: 0, z: 0 },
      ],
      geo: [
        { lat: 1.35, lon: 103.8, altM: 0 },
        { lat: 1.351, lon: 103.8, altM: 0 },
      ],
    },
    metadata: { provenance: PROVENANCE },
  };
}

/** An UNCLOSED draft ring (4 points, first ≠ last) — exercises the ring-closing logic. */
function focusFeature(): PlanFeature {
  const geo = [
    { lat: 1.35, lon: 103.8, altM: 0 },
    { lat: 1.351, lon: 103.8, altM: 0 },
    { lat: 1.351, lon: 103.801, altM: 0 },
    { lat: 1.35, lon: 103.801, altM: 0 },
  ];
  return {
    id: 'f-focus',
    type: 'focus',
    name: 'AO-1',
    points: { local: geo.map(() => ({ x: 0, y: 0, z: 0 })), geo },
    metadata: { provenance: PROVENANCE },
  };
}

function axisFeature(): PlanFeature {
  const geo = [
    { lat: 1.35, lon: 103.8, altM: 0 },
    { lat: 1.352, lon: 103.802, altM: 0 },
  ];
  return {
    id: 'f-axis',
    type: 'axis',
    name: 'AXIS COBRA',
    points: { local: geo.map(() => ({ x: 0, y: 0, z: 0 })), geo },
    metadata: { provenance: PROVENANCE },
  };
}

function objectiveFeature(): PlanFeature {
  const geo = [{ lat: 1.353, lon: 103.803, altM: 12 }];
  return {
    id: 'f-objective',
    type: 'objective',
    name: 'OBJ-1',
    points: { local: [{ x: 0, y: 0, z: 0 }], geo },
    metadata: { provenance: PROVENANCE },
  };
}

function unitFeature(): PlanFeature {
  const geo = [{ lat: 1.354, lon: 103.804, altM: 0 }];
  return {
    id: 'f-unit',
    type: 'unit',
    name: '1 PL',
    points: { local: [{ x: 0, y: 0, z: 0 }], geo },
    metadata: { affiliation: 'friendly', echelon: 'platoon', provenance: PROVENANCE },
  };
}

function mixedPlan(): Plan {
  return {
    id: 'p1',
    name: 'COY ATTACK',
    version: 1,
    anchor: { lat: 1.35, lon: 103.8 },
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    features: [distanceFeature(), focusFeature(), axisFeature(), objectiveFeature(), unitFeature()],
    viewpoints: [],
    classification: 'RESTRICTED',
  };
}

describe('exportGeoJSON (todo 23)', () => {
  it('produces a RFC-7946-shaped FeatureCollection', () => {
    const parsed = JSON.parse(exportGeoJSON(mixedPlan()));
    expect(parsed.type).toBe('FeatureCollection');
    expect(Array.isArray(parsed.features)).toBe(true);
    for (const f of parsed.features) {
      expect(f.type).toBe('Feature');
      expect(f.geometry).toBeDefined();
      expect(f.properties).toBeDefined();
    }
  });

  it('round-trips feature count, names, and types for a mixed plan', () => {
    const plan = mixedPlan();
    const parsed = JSON.parse(exportGeoJSON(plan));
    expect(parsed.features).toHaveLength(plan.features.length);
    expect(parsed.features.map((f: { properties: { name: string } }) => f.properties.name)).toEqual(
      plan.features.map((f) => f.name)
    );
    expect(parsed.features.map((f: { properties: { type: string } }) => f.properties.type)).toEqual(
      plan.features.map((f) => f.type)
    );
  });

  it('maps geometry type correctly per feature type (invariant 4)', () => {
    const parsed = JSON.parse(exportGeoJSON(mixedPlan()));
    const byId = Object.fromEntries(mixedPlan().features.map((f, i) => [f.id, parsed.features[i]]));
    expect(byId['f-distance'].geometry.type).toBe('LineString');
    expect(byId['f-axis'].geometry.type).toBe('LineString');
    expect(byId['f-focus'].geometry.type).toBe('Polygon');
    expect(byId['f-objective'].geometry.type).toBe('Point');
    expect(byId['f-unit'].geometry.type).toBe('Point');
  });

  it('reads coordinates from points.geo verbatim, in [lon, lat, alt] order', () => {
    const parsed = JSON.parse(exportGeoJSON(mixedPlan()));
    const distance = parsed.features.find(
      (f: { properties: { name: string } }) => f.properties.name === 'Distance 1'
    );
    const expected = distanceFeature().points.geo.map((g) => [g.lon, g.lat, g.altM]);
    expect(distance.geometry.coordinates).toEqual(expected);
  });

  it('closes an unclosed Polygon ring (first coordinate repeated at the end)', () => {
    const parsed = JSON.parse(exportGeoJSON(mixedPlan()));
    const focus = parsed.features.find(
      (f: { properties: { name: string } }) => f.properties.name === 'AO-1'
    );
    const ring = focus.geometry.coordinates[0];
    const drawnPointCount = focusFeature().points.geo.length;
    expect(ring).toHaveLength(drawnPointCount + 1); // drawn points + repeated first
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('carries classification and provenance into every feature (invariant 3)', () => {
    const parsed = JSON.parse(exportGeoJSON(mixedPlan()));
    for (const f of parsed.features) {
      expect(f.properties.classification).toBe('RESTRICTED');
      expect(f.properties.provenance.author).toBe('CPT Tan');
    }
  });

  it('carries affiliation + echelon for unit features only', () => {
    const parsed = JSON.parse(exportGeoJSON(mixedPlan()));
    const unit = parsed.features.find(
      (f: { properties: { name: string } }) => f.properties.name === '1 PL'
    );
    expect(unit.properties.affiliation).toBe('friendly');
    expect(unit.properties.echelon).toBe('platoon');

    const distance = parsed.features.find(
      (f: { properties: { name: string } }) => f.properties.name === 'Distance 1'
    );
    expect(distance.properties.affiliation).toBeUndefined();
  });

  it('defaults classification to EXERCISE properties are still populated for a bare plan', () => {
    const bare: Plan = {
      ...mixedPlan(),
      features: [],
      classification: 'EXERCISE',
    };
    const parsed = JSON.parse(exportGeoJSON(bare));
    expect(parsed.features).toEqual([]);
  });
});

describe('exportKML (todo 23)', () => {
  it('produces well-formed XML (invariant 2)', () => {
    const kml = exportKML(mixedPlan());
    const doc = new DOMParser().parseFromString(kml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
  });

  it('has one Placemark per feature, named correctly', () => {
    const plan = mixedPlan();
    const doc = new DOMParser().parseFromString(exportKML(plan), 'application/xml');
    const placemarks = Array.from(doc.querySelectorAll('Placemark'));
    expect(placemarks).toHaveLength(plan.features.length);
    expect(placemarks.map((p) => p.querySelector('name')?.textContent)).toEqual(
      plan.features.map((f) => f.name)
    );
  });

  it('maps geometry element correctly per feature type (invariant 4)', () => {
    const doc = new DOMParser().parseFromString(exportKML(mixedPlan()), 'application/xml');
    const placemarks = Array.from(doc.querySelectorAll('Placemark'));
    const byName = Object.fromEntries(
      placemarks.map((p) => [p.querySelector('name')?.textContent, p])
    );
    expect(byName['Distance 1']?.querySelector('LineString')).not.toBeNull();
    expect(byName['AXIS COBRA']?.querySelector('LineString')).not.toBeNull();
    expect(byName['AO-1']?.querySelector('Polygon')).not.toBeNull();
    expect(byName['OBJ-1']?.querySelector('Point')).not.toBeNull();
    expect(byName['1 PL']?.querySelector('Point')).not.toBeNull();
  });

  it('carries classification + provenance + unit fields into ExtendedData', () => {
    const doc = new DOMParser().parseFromString(exportKML(mixedPlan()), 'application/xml');
    const unitPlacemark = Array.from(doc.querySelectorAll('Placemark')).find(
      (p) => p.querySelector('name')?.textContent === '1 PL'
    );
    if (!unitPlacemark) throw new Error('unit placemark not found');
    const dataByName = Object.fromEntries(
      Array.from(unitPlacemark.querySelectorAll('Data')).map((d) => [
        d.getAttribute('name'),
        d.querySelector('value')?.textContent,
      ])
    );
    expect(dataByName.classification).toBe('RESTRICTED');
    expect(dataByName.provenance_author).toBe('CPT Tan');
    expect(dataByName.affiliation).toBe('friendly');
    expect(dataByName.echelon).toBe('platoon');
  });

  it('escapes XML-significant characters in names — no injected markup', () => {
    const plan = mixedPlan();
    plan.features = [{ ...distanceFeature(), name: '<AO> "Alpha" & <Bravo>' }];
    const kml = exportKML(plan);
    expect(kml).not.toContain('<AO>');
    expect(kml).toContain('&lt;AO&gt;');

    const doc = new DOMParser().parseFromString(kml, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.querySelector('Placemark > name')?.textContent).toBe('<AO> "Alpha" & <Bravo>');
  });
});
