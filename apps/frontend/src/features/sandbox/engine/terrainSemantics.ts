import type { Vector3 } from 'three';

import type { GeoFrame } from './geoFrame';

export type TerrainObstacleKind = 'building' | 'water';
export type TerrainSurfaceClass = TerrainObstacleKind | 'clear' | 'unknown';
export type TerrainSemanticsStatus = 'loading' | 'ready' | 'error';

export interface TerrainSemanticsSummary {
  readonly status: TerrainSemanticsStatus;
  readonly buildingCount: number;
  readonly waterCount: number;
  readonly message: string;
}

export interface LocalObstaclePolygon {
  readonly kind: TerrainObstacleKind;
  readonly points: readonly LocalObstaclePoint[];
}

export interface LocalObstaclePoint {
  readonly x: number;
  readonly z: number;
}

export interface LocalObstacleBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface LocalCoastline {
  readonly points: readonly LocalObstaclePoint[];
  /** OSM coastlines are directed with land on the left and water on the right. */
  readonly waterSide: 'left' | 'right';
}

export interface SemanticObstacleMapOptions {
  readonly coastlines?: readonly LocalCoastline[];
  readonly coveragePolygon?: readonly LocalObstaclePoint[];
}

interface IndexedPolygon extends LocalObstaclePolygon {
  readonly bounds: LocalObstacleBounds;
}

interface IndexedCoastline extends LocalCoastline {
  readonly points: readonly LocalObstaclePoint[];
}

interface GeoCoordinate {
  readonly lat: number;
  readonly lon: number;
}

interface GeoObstaclePolygon {
  readonly kind: TerrainObstacleKind;
  readonly points: readonly GeoCoordinate[];
}

interface GeoCoastline {
  readonly points: readonly GeoCoordinate[];
}

interface GeoObstacleData {
  readonly polygons: readonly GeoObstaclePolygon[];
  readonly coastlines: readonly GeoCoastline[];
}

interface OverpassMember {
  readonly role?: string;
  readonly geometry?: readonly GeoCoordinate[];
}

interface OverpassElement {
  readonly type?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly geometry?: readonly GeoCoordinate[];
  readonly members?: readonly OverpassMember[];
}

interface CachedObstaclePayload {
  readonly savedAt: number;
  readonly polygons: readonly GeoObstaclePolygon[];
  readonly coastlines: readonly GeoCoastline[];
}

interface CachedObstacleResult {
  readonly data: GeoObstacleData;
  readonly freshness: 'fresh' | 'stale';
}

interface TerrainLoadArea {
  readonly lat: number;
  readonly lon: number;
  readonly radiusM: number;
}

const OVERPASS_ENDPOINTS = Object.freeze([
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  // Kumi Systems' public service moved to Private.coffee in 2026.
  'https://overpass.private.coffee/api/interpreter',
]);
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const CACHE_PREFIX = 'sentinel_osm_obstacles_v2';
const CACHE_COORD_PRECISION = 5;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_RADIUS_M = 1_000;
const MAX_RADIUS_M = 25_000;
const METRES_PER_LATITUDE_DEGREE = 111_320;
const MIN_LONGITUDE_SCALE = 0.15;
const OVERPASS_QUERY_TIMEOUT_SECONDS = 10;
// Keep the browser deadline above Overpass's own query budget. The previous 8 s deadline
// guaranteed that a valid 8-10 s response was aborted before the server could finish it.
const FETCH_ATTEMPT_TIMEOUT_MS = 15_000;
const MAX_ELEMENTS = 12_000;
const MAX_POLYGONS = 8_000;
const MAX_COASTLINES = 2_000;
const MAX_VERTICES_PER_POLYGON = 4_000;
const MAX_TOTAL_COASTLINE_VERTICES = 20_000;
const GRID_CELL_SIZE_M = 64;
const COORDINATE_EPSILON = 1e-7;

export const TERRAIN_DATA_ATTRIBUTION = OSM_ATTRIBUTION;

/** Fast immutable spatial lookup over independently sourced building/water polygons. */
export class SemanticObstacleMap {
  private readonly polygons: readonly IndexedPolygon[];
  private readonly coastlines: readonly IndexedCoastline[];
  private readonly coverage: LocalObstacleBounds;
  private readonly coveragePolygon: readonly LocalObstaclePoint[];
  private readonly cells = new Map<string, readonly number[]>();
  private readonly buildingCount: number;
  private readonly waterCount: number;

  constructor(
    polygons: readonly LocalObstaclePolygon[],
    coverage: LocalObstacleBounds,
    options: SemanticObstacleMapOptions = {}
  ) {
    this.coverage = freezeAndValidateBounds(coverage);
    this.coveragePolygon = sanitizeLocalPoints(
      options.coveragePolygon ?? boundsPolygon(this.coverage),
      3,
      'coverage polygon'
    );
    if (Math.abs(polygonSignedArea(this.coveragePolygon)) <= COORDINATE_EPSILON) {
      throw new Error('Semantic coverage polygon was degenerate');
    }
    if (
      this.coveragePolygon.some(
        (point) => !containsExpanded(this.coverage, point, COORDINATE_EPSILON)
      )
    ) {
      throw new Error('Semantic coverage polygon exceeded its bounds');
    }
    this.polygons = Object.freeze(
      polygons.map((polygon) => {
        if (polygon.kind !== 'building' && polygon.kind !== 'water') {
          throw new Error('Obstacle polygon kind was invalid');
        }
        const points = sanitizeLocalPoints(polygon.points, 3, `${polygon.kind} polygon`);
        if (Math.abs(polygonSignedArea(points)) <= COORDINATE_EPSILON) {
          throw new Error(`${polygon.kind} polygon was degenerate`);
        }
        return Object.freeze({
          kind: polygon.kind,
          points,
          bounds: polygonBounds(points),
        });
      })
    );
    this.coastlines = Object.freeze(
      (options.coastlines ?? []).map((coastline) => {
        if (coastline.waterSide !== 'left' && coastline.waterSide !== 'right') {
          throw new Error('Coastline water side was invalid');
        }
        return Object.freeze({
          waterSide: coastline.waterSide,
          points: sanitizeLocalPoints(coastline.points, 2, 'coastline', false),
        });
      })
    );
    this.buildingCount = this.polygons.filter((polygon) => polygon.kind === 'building').length;
    this.waterCount = this.polygons.length - this.buildingCount + this.coastlines.length;
    this.buildGrid();
  }

  public classify(point: LocalObstaclePoint, clearanceM: number): TerrainSurfaceClass {
    if (!isFiniteLocalPoint(point) || !Number.isFinite(clearanceM)) return 'unknown';
    const clearance = Math.max(0, clearanceM);
    if (
      !containsExpanded(this.coverage, point, -clearance) ||
      !pointInsideCoverage(point, this.coveragePolygon, clearance)
    ) {
      return 'unknown';
    }

    const candidates = this.candidatePolygonIndexes(point, clearance);
    let waterDetected = false;
    for (const index of candidates) {
      const polygon = this.polygons[index];
      if (!containsExpanded(polygon.bounds, point, clearance)) continue;
      if (!pointTouchesPolygon(point, polygon.points, clearance)) continue;
      if (polygon.kind === 'building') return 'building';
      waterDetected = true;
    }
    if (waterDetected || pointTouchesCoastlineWater(point, this.coastlines, clearance)) {
      return 'water';
    }
    return 'clear';
  }

  public get counts(): { readonly buildings: number; readonly water: number } {
    return Object.freeze({ buildings: this.buildingCount, water: this.waterCount });
  }

  private buildGrid(): void {
    const mutableCells = new Map<string, number[]>();
    this.polygons.forEach((polygon, polygonIndex) => {
      const minCellX = cellCoordinate(Math.max(polygon.bounds.minX, this.coverage.minX));
      const maxCellX = cellCoordinate(Math.min(polygon.bounds.maxX, this.coverage.maxX));
      const minCellZ = cellCoordinate(Math.max(polygon.bounds.minZ, this.coverage.minZ));
      const maxCellZ = cellCoordinate(Math.min(polygon.bounds.maxZ, this.coverage.maxZ));
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
          const key = cellKey(cellX, cellZ);
          const indexes = mutableCells.get(key) ?? [];
          indexes.push(polygonIndex);
          mutableCells.set(key, indexes);
        }
      }
    });
    for (const [key, indexes] of mutableCells) this.cells.set(key, Object.freeze(indexes));
  }

  private candidatePolygonIndexes(
    point: LocalObstaclePoint,
    clearanceM: number
  ): ReadonlySet<number> {
    const indexes = new Set<number>();
    const minCellX = cellCoordinate(point.x - clearanceM);
    const maxCellX = cellCoordinate(point.x + clearanceM);
    const minCellZ = cellCoordinate(point.z - clearanceM);
    const maxCellZ = cellCoordinate(point.z + clearanceM);
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        for (const index of this.cells.get(cellKey(cellX, cellZ)) ?? []) indexes.add(index);
      }
    }
    return indexes;
  }
}

/** Loads OSM semantics once per sandbox area; Google tiles remain visual-only. */
export class TerrainSemanticIndex {
  private readonly geoFrame: GeoFrame;
  private map: SemanticObstacleMap | null = null;
  private status: TerrainSemanticsStatus = 'loading';
  private message = 'Loading mapped buildings and water…';
  private abortController: AbortController | null = null;
  private lastRequest: TerrainLoadArea | null = null;
  private disposed = false;

  constructor(geoFrame: GeoFrame) {
    this.geoFrame = geoFrame;
  }

  public async load(lat: number, lon: number, radiusM = DEFAULT_RADIUS_M): Promise<void> {
    if (this.disposed) return;
    try {
      validateLoadArea(lat, lon, radiusM);
    } catch (error) {
      this.status = 'error';
      this.message = this.map
        ? 'Invalid refresh area — last-known obstacle coverage remains active'
        : 'Obstacle data unavailable — the requested area was invalid';
      console.warn('[terrain-semantics] OSM obstacle load rejected:', error);
      return;
    }

    const area = Object.freeze({ lat, lon, radiusM });
    this.lastRequest = area;
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.status = 'loading';
    this.message = this.map
      ? 'Refreshing mapped buildings and water — last-known coverage remains active'
      : 'Loading mapped buildings and water…';

    const bounds = geoBounds(lat, lon, radiusM);
    const key = cacheKey(lat, lon, radiusM);
    let fallbackSource: 'last-known' | 'stale' | null = this.map ? 'last-known' : null;

    try {
      const cached = readCache(key);
      if (cached) {
        try {
          const cachedMap = buildSemanticObstacleMap(this.geoFrame, cached.data, bounds);
          this.map = cachedMap;
          if (cached.freshness === 'fresh') {
            this.status = 'ready';
            this.message = mappedCoverageMessage(cachedMap, 'mapped');
            return;
          }
          fallbackSource = 'stale';
          this.message = 'Refreshing mapped buildings and water — stale cached coverage active';
        } catch {
          removeCache(key);
        }
      }

      const obstacleData = await fetchObstacleData(bounds, abortController.signal);
      if (this.disposed || abortController.signal.aborted) return;
      const nextMap = buildSemanticObstacleMap(this.geoFrame, obstacleData, bounds);
      this.map = nextMap;
      writeCache(key, obstacleData);
      this.status = 'ready';
      this.message = mappedCoverageMessage(nextMap, 'mapped');
    } catch (error) {
      if (this.disposed || abortController.signal.aborted) return;
      this.status = 'error';
      if (this.map) {
        const source = fallbackSource === 'stale' ? 'stale cached' : 'last-known';
        this.message = mappedCoverageMessage(
          this.map,
          `live refresh unavailable — ${source} coverage active`
        );
      } else {
        this.message = 'Live obstacle data unavailable — no mapped coverage is currently active';
      }
      console.warn('[terrain-semantics] OSM obstacle fetch failed:', error);
    } finally {
      if (this.abortController === abortController) this.abortController = null;
    }
  }

  public retry(): Promise<void> {
    if (this.disposed || !this.lastRequest) return Promise.resolve();
    return this.load(this.lastRequest.lat, this.lastRequest.lon, this.lastRequest.radiusM);
  }

  public classifyWorld(
    position: Pick<Vector3, 'x' | 'z'>,
    clearanceM: number
  ): TerrainSurfaceClass {
    if (!this.map) return 'unknown';
    return this.map.classify(position, clearanceM);
  }

  public get summary(): TerrainSemanticsSummary {
    const counts = this.map?.counts ?? { buildings: 0, water: 0 };
    return Object.freeze({
      status: this.status,
      buildingCount: counts.buildings,
      waterCount: counts.water,
      message: this.message,
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.map = null;
  }
}

function buildSemanticObstacleMap(
  geoFrame: GeoFrame,
  obstacleData: GeoObstacleData,
  bounds: GeoBounds
): SemanticObstacleMap {
  const localPolygons = obstacleData.polygons.map((polygon) => ({
    kind: polygon.kind,
    points: polygon.points.map((point) => {
      const local = geoFrame.geoToLocal({ lat: point.lat, lon: point.lon, altM: 0 });
      return { x: local.x, z: local.z };
    }),
  }));
  const localCoastlines = obstacleData.coastlines.map((coastline) =>
    localizeCoastline(geoFrame, coastline)
  );
  const coverage = localCoverageGeometry(geoFrame, bounds);
  return new SemanticObstacleMap(localPolygons, coverage.bounds, {
    coastlines: localCoastlines,
    coveragePolygon: coverage.polygon,
  });
}

function mappedCoverageMessage(map: SemanticObstacleMap, description: string): string {
  const counts = map.counts;
  return `${counts.buildings} buildings · ${counts.water} water areas; ${description}`;
}

interface GeoBounds {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

interface LocalCoverageGeometry {
  readonly bounds: LocalObstacleBounds;
  readonly polygon: readonly LocalObstaclePoint[];
}

async function fetchObstacleData(bounds: GeoBounds, signal: AbortSignal): Promise<GeoObstacleData> {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const query = `
    [out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SECONDS}];
    (
      way["building"](${bbox}); relation["building"](${bbox});
      way["building:part"](${bbox}); relation["building:part"](${bbox});
      way["natural"~"water|wetland"](${bbox}); relation["natural"~"water|wetland"](${bbox});
      way["water"](${bbox}); relation["water"](${bbox});
      way["waterway"~"riverbank|dock"](${bbox}); relation["waterway"~"riverbank|dock"](${bbox});
      way["landuse"~"reservoir|basin"](${bbox}); relation["landuse"~"reservoir|basin"](${bbox});
      way["natural"="coastline"](${bbox});
    );
    out body geom;
  `;
  const failures: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal.aborted) throw new Error('Overpass request aborted');
    try {
      return await fetchObstacleDataFromEndpoint(endpoint, query, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${endpoint}: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }
  throw new Error(`All Overpass endpoints failed (${failures.join('; ')})`);
}

async function fetchObstacleDataFromEndpoint(
  endpoint: string,
  query: string,
  signal: AbortSignal
): Promise<GeoObstacleData> {
  const requestController = new AbortController();
  const forwardAbort = (): void => requestController.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });
  if (signal.aborted) requestController.abort();
  const timeout = globalThis.setTimeout(() => requestController.abort(), FETCH_ATTEMPT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: requestController.signal,
    });
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) throw new Error('Overpass response was not an object');
    if (typeof body.remark === 'string' && body.remark.trim().length > 0) {
      throw new Error(`Overpass returned a partial result: ${body.remark}`);
    }
    const elements = body.elements;
    if (!Array.isArray(elements)) throw new Error('Overpass response omitted elements');
    if (elements.length > MAX_ELEMENTS) {
      throw new Error(`Overpass response exceeded ${MAX_ELEMENTS} elements`);
    }
    return parseObstacleElements(elements);
  } finally {
    globalThis.clearTimeout(timeout);
    signal.removeEventListener('abort', forwardAbort);
  }
}

function parseObstacleElements(elements: readonly unknown[]): GeoObstacleData {
  const polygons: GeoObstaclePolygon[] = [];
  const coastlines: GeoCoastline[] = [];
  let coastlineVertices = 0;
  for (const rawElement of elements) {
    const element = semanticOverpassElement(rawElement);
    if (!element) continue;
    if (isCoastline(element.tags)) {
      if (element.type !== 'way' || !element.geometry) {
        throw new Error('Coastline element omitted way geometry');
      }
      const points = sanitizeGeoLine(element.geometry, 'coastline');
      coastlineVertices += points.length;
      if (
        coastlines.length + 1 >= MAX_COASTLINES ||
        coastlineVertices >= MAX_TOTAL_COASTLINE_VERTICES
      ) {
        throw new Error('Coastline safety limit reached');
      }
      coastlines.push(Object.freeze({ points: Object.freeze(points) }));
      continue;
    }

    const kind = obstacleKind(element.tags);
    if (!kind) continue;
    for (const ring of elementRings(element)) {
      const points = sanitizeGeoRing(ring);
      if (points.length < 3) throw new Error('Obstacle polygon had fewer than three vertices');
      polygons.push(Object.freeze({ kind, points: Object.freeze(points) }));
      if (polygons.length >= MAX_POLYGONS) {
        throw new Error('Obstacle polygon safety limit reached');
      }
    }
  }
  return Object.freeze({
    polygons: Object.freeze(polygons),
    coastlines: Object.freeze(coastlines),
  });
}

function semanticOverpassElement(value: unknown): OverpassElement | null {
  if (!isRecord(value)) return null;
  const tags = readTags(value.tags);
  if (!isCoastline(tags) && !obstacleKind(tags)) return null;

  const type = value.type;
  if (type !== 'way' && type !== 'relation') {
    throw new Error('Semantic Overpass element had an unsupported type');
  }
  if (type === 'way') {
    const geometry = readGeoCoordinates(value.geometry, 'way geometry');
    if (!geometry) throw new Error('Semantic Overpass way omitted geometry');
    return Object.freeze({ type, tags, geometry });
  }

  if (!Array.isArray(value.members) || value.members.length > MAX_ELEMENTS) {
    throw new Error('Semantic Overpass relation omitted valid members');
  }
  const members = value.members.map((member) => readOverpassMember(member));
  return Object.freeze({ type, tags, members: Object.freeze(members) });
}

function readTags(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Overpass element tags were malformed');
  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (typeof tagValue !== 'string') throw new Error('Overpass tag value was not a string');
    tags[key] = tagValue;
  }
  return Object.freeze(tags);
}

function readOverpassMember(value: unknown): OverpassMember {
  if (!isRecord(value)) throw new Error('Overpass relation member was malformed');
  if (value.role !== undefined && typeof value.role !== 'string') {
    throw new Error('Overpass relation member role was malformed');
  }
  const role = typeof value.role === 'string' ? value.role : undefined;
  const isOuter = role === undefined || role === '' || role === 'outer';
  const geometry = readGeoCoordinates(value.geometry, 'relation member geometry');
  if (isOuter && (!geometry || geometry.length < 2)) {
    throw new Error('Overpass outer relation member omitted geometry');
  }
  return Object.freeze({
    ...(role === undefined ? {} : { role }),
    ...(geometry === undefined ? {} : { geometry }),
  });
}

function readGeoCoordinates(value: unknown, label: string): readonly GeoCoordinate[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} was not an array`);
  if (value.length > MAX_VERTICES_PER_POLYGON) {
    throw new Error(`${label} exceeded the per-feature vertex limit`);
  }
  return Object.freeze(
    value.map((coordinate) => {
      if (!isRecord(coordinate)) throw new Error(`${label} contained a malformed coordinate`);
      const { lat, lon } = coordinate;
      if (
        typeof lat !== 'number' ||
        typeof lon !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      ) {
        throw new Error(`${label} contained an invalid coordinate`);
      }
      return Object.freeze({ lat, lon });
    })
  );
}

function elementRings(element: OverpassElement): readonly (readonly GeoCoordinate[])[] {
  if (element.type === 'way') {
    if (!element.geometry || element.geometry.length < 4) {
      throw new Error('Obstacle way omitted polygon geometry');
    }
    if (!sameGeoPoint(element.geometry[0], element.geometry[element.geometry.length - 1])) {
      throw new Error('Obstacle way geometry was not closed');
    }
    return [element.geometry];
  }
  const segments =
    element.members
      ?.filter((member) => member.role !== 'inner' && member.geometry)
      .map((member) => member.geometry ?? []) ?? [];
  if (segments.length === 0) throw new Error('Obstacle relation omitted outer geometry');
  return stitchSegments(segments);
}

function stitchSegments(
  sourceSegments: readonly (readonly GeoCoordinate[])[]
): readonly (readonly GeoCoordinate[])[] {
  const remaining = sourceSegments.map((segment) => [...segment]);
  const rings: GeoCoordinate[][] = [];
  while (remaining.length > 0) {
    const ring = remaining.shift() ?? [];
    let joined = true;
    while (ring.length >= 2 && !sameGeoPoint(ring[0], ring[ring.length - 1]) && joined) {
      joined = false;
      const end = ring[ring.length - 1];
      const matchIndex = remaining.findIndex(
        (segment) => sameGeoPoint(segment[0], end) || sameGeoPoint(segment[segment.length - 1], end)
      );
      if (matchIndex < 0) break;
      const segment = remaining.splice(matchIndex, 1)[0];
      if (!sameGeoPoint(segment[0], end)) segment.reverse();
      ring.push(...segment.slice(1));
      joined = true;
    }
    if (ring.length < 4 || !sameGeoPoint(ring[0], ring[ring.length - 1])) {
      throw new Error('Obstacle relation contained an unclosed outer ring');
    }
    if (ring.length > MAX_VERTICES_PER_POLYGON) {
      throw new Error('Obstacle relation exceeded the per-polygon vertex limit');
    }
    rings.push(ring);
  }
  return rings;
}

function sanitizeGeoRing(points: readonly GeoCoordinate[]): GeoCoordinate[] {
  if (points.length > MAX_VERTICES_PER_POLYGON) {
    throw new Error('Obstacle geometry exceeded the per-polygon vertex limit');
  }
  const sanitized: GeoCoordinate[] = [];
  for (const point of points) {
    const previous = sanitized[sanitized.length - 1];
    if (!previous || !sameGeoPoint(previous, point))
      sanitized.push({ lat: point.lat, lon: point.lon });
  }
  if (sanitized.length > 1 && sameGeoPoint(sanitized[0], sanitized[sanitized.length - 1])) {
    sanitized.pop();
  }
  return sanitized;
}

function sanitizeGeoLine(points: readonly GeoCoordinate[], label: string): GeoCoordinate[] {
  if (points.length > MAX_VERTICES_PER_POLYGON) {
    throw new Error(`${label} exceeded the per-feature vertex limit`);
  }
  const sanitized: GeoCoordinate[] = [];
  for (const point of points) {
    const previous = sanitized[sanitized.length - 1];
    if (!previous || !sameGeoPoint(previous, point)) {
      sanitized.push({ lat: point.lat, lon: point.lon });
    }
  }
  if (sanitized.length < 2) throw new Error(`${label} had fewer than two vertices`);
  return sanitized;
}

function obstacleKind(
  tags: Readonly<Record<string, string>> | undefined
): TerrainObstacleKind | null {
  if (!tags) return null;
  if (
    (tags.building && tags.building !== 'no') ||
    (tags['building:part'] && tags['building:part'] !== 'no')
  ) {
    return 'building';
  }
  if (
    tags.natural === 'water' ||
    tags.natural === 'wetland' ||
    (tags.water !== undefined && tags.water !== 'no') ||
    tags.waterway === 'riverbank' ||
    tags.waterway === 'dock' ||
    tags.landuse === 'reservoir' ||
    tags.landuse === 'basin'
  ) {
    return 'water';
  }
  return null;
}

function isCoastline(tags: Readonly<Record<string, string>> | undefined): boolean {
  return tags?.natural === 'coastline';
}

function geoBounds(lat: number, lon: number, radiusM: number): GeoBounds {
  const latitudeDelta = radiusM / METRES_PER_LATITUDE_DEGREE;
  const longitudeScale = Math.max(MIN_LONGITUDE_SCALE, Math.cos((lat * Math.PI) / 180));
  const longitudeDelta = radiusM / (METRES_PER_LATITUDE_DEGREE * longitudeScale);
  const bounds = {
    south: lat - latitudeDelta,
    west: lon - longitudeDelta,
    north: lat + latitudeDelta,
    east: lon + longitudeDelta,
  };
  if (bounds.south < -90 || bounds.north > 90 || bounds.west < -180 || bounds.east > 180) {
    throw new Error('Semantic coverage cannot cross a pole or the antimeridian');
  }
  return bounds;
}

function validateLoadArea(lat: number, lon: number, radiusM: number): void {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(radiusM) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    radiusM <= 0 ||
    radiusM > MAX_RADIUS_M
  ) {
    throw new Error('Semantic coverage coordinates or radius were invalid');
  }
}

function localCoverageGeometry(geoFrame: GeoFrame, bounds: GeoBounds): LocalCoverageGeometry {
  const corners = [
    geoFrame.geoToLocal({ lat: bounds.south, lon: bounds.west, altM: 0 }),
    geoFrame.geoToLocal({ lat: bounds.south, lon: bounds.east, altM: 0 }),
    geoFrame.geoToLocal({ lat: bounds.north, lon: bounds.east, altM: 0 }),
    geoFrame.geoToLocal({ lat: bounds.north, lon: bounds.west, altM: 0 }),
  ];
  const polygon = Object.freeze(
    corners.map((corner) => Object.freeze({ x: corner.x, z: corner.z }))
  );
  return Object.freeze({ bounds: polygonBounds(polygon), polygon });
}

function localizeCoastline(geoFrame: GeoFrame, coastline: GeoCoastline): LocalCoastline {
  const points = coastline.points.map((point) => {
    const local = geoFrame.geoToLocal({ lat: point.lat, lon: point.lon, altM: 0 });
    return Object.freeze({ x: local.x, z: local.z });
  });

  for (let index = 0; index < coastline.points.length - 1; index += 1) {
    const startGeo = coastline.points[index];
    const endGeo = coastline.points[index + 1];
    const startLocal = points[index];
    const endLocal = points[index + 1];
    if (squaredDistance(startLocal, endLocal) <= COORDINATE_EPSILON) continue;

    const waterProbe = rightSideGeoProbe(startGeo, endGeo);
    if (!waterProbe) continue;
    const probeLocalVector = geoFrame.geoToLocal({ ...waterProbe, altM: 0 });
    const probeLocal = { x: probeLocalVector.x, z: probeLocalVector.z };
    const side = crossProduct(startLocal, endLocal, probeLocal);
    if (Math.abs(side) <= COORDINATE_EPSILON) continue;

    return Object.freeze({
      points: Object.freeze(points),
      waterSide: side > 0 ? 'left' : 'right',
    });
  }
  throw new Error('Coastline could not be oriented in the local frame');
}

function rightSideGeoProbe(start: GeoCoordinate, end: GeoCoordinate): GeoCoordinate | null {
  const longitudeDelta = shortestLongitudeDelta(end.lon - start.lon);
  const midpointLat = (start.lat + end.lat) / 2;
  const midpointLon = normalizeLongitude(start.lon + longitudeDelta / 2);
  const longitudeScale = Math.max(MIN_LONGITUDE_SCALE, Math.cos((midpointLat * Math.PI) / 180));
  const eastM = longitudeDelta * METRES_PER_LATITUDE_DEGREE * longitudeScale;
  const northM = (end.lat - start.lat) * METRES_PER_LATITUDE_DEGREE;
  const lengthM = Math.hypot(eastM, northM);
  if (lengthM <= COORDINATE_EPSILON) return null;

  const probeDistanceM = 10;
  const rightEastM = (northM / lengthM) * probeDistanceM;
  const rightNorthM = (-eastM / lengthM) * probeDistanceM;
  return Object.freeze({
    lat: midpointLat + rightNorthM / METRES_PER_LATITUDE_DEGREE,
    lon: normalizeLongitude(
      midpointLon + rightEastM / (METRES_PER_LATITUDE_DEGREE * longitudeScale)
    ),
  });
}

function freezeAndValidateBounds(bounds: LocalObstacleBounds): LocalObstacleBounds {
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.minZ) ||
    !Number.isFinite(bounds.maxZ) ||
    bounds.minX >= bounds.maxX ||
    bounds.minZ >= bounds.maxZ
  ) {
    throw new Error('Semantic coverage bounds were invalid');
  }
  return Object.freeze({ ...bounds });
}

function boundsPolygon(bounds: LocalObstacleBounds): readonly LocalObstaclePoint[] {
  return Object.freeze([
    Object.freeze({ x: bounds.minX, z: bounds.minZ }),
    Object.freeze({ x: bounds.maxX, z: bounds.minZ }),
    Object.freeze({ x: bounds.maxX, z: bounds.maxZ }),
    Object.freeze({ x: bounds.minX, z: bounds.maxZ }),
  ]);
}

function sanitizeLocalPoints(
  source: readonly LocalObstaclePoint[],
  minimumPoints: number,
  label: string,
  removeClosingPoint = true
): readonly LocalObstaclePoint[] {
  const points: LocalObstaclePoint[] = [];
  for (const point of source) {
    if (!isFiniteLocalPoint(point)) throw new Error(`${label} contained an invalid point`);
    const previous = points[points.length - 1];
    if (!previous || squaredDistance(previous, point) > Number.EPSILON) {
      points.push(Object.freeze({ x: point.x, z: point.z }));
    }
  }
  if (
    removeClosingPoint &&
    points.length > 1 &&
    squaredDistance(points[0], points[points.length - 1]) <= Number.EPSILON
  ) {
    points.pop();
  }
  if (points.length < minimumPoints) {
    throw new Error(`${label} had fewer than ${minimumPoints} distinct points`);
  }
  return Object.freeze(points);
}

function pointInsideCoverage(
  point: LocalObstaclePoint,
  coverage: readonly LocalObstaclePoint[],
  clearanceM: number
): boolean {
  if (!pointInPolygon(point, coverage) && !pointTouchesPolygon(point, coverage, 0)) return false;
  if (clearanceM === 0) return true;

  const clearanceSquared = clearanceM * clearanceM;
  for (let index = 0; index < coverage.length; index += 1) {
    const start = coverage[index];
    const end = coverage[(index + 1) % coverage.length];
    if (distanceToSegmentSquared(point, start, end) < clearanceSquared) return false;
  }
  return true;
}

function pointTouchesCoastlineWater(
  point: LocalObstaclePoint,
  coastlines: readonly IndexedCoastline[],
  clearanceM: number
): boolean {
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  let nearestIsWater = false;

  for (const coastline of coastlines) {
    const waterSideSign = coastline.waterSide === 'left' ? 1 : -1;
    for (let index = 0; index < coastline.points.length - 1; index += 1) {
      const start = coastline.points[index];
      const end = coastline.points[index + 1];
      const candidateDistanceSquared = distanceToSegmentSquared(point, start, end);
      if (candidateDistanceSquared >= nearestDistanceSquared) continue;
      nearestDistanceSquared = candidateDistanceSquared;
      const side = crossProduct(start, end, point);
      nearestIsWater = Math.abs(side) <= COORDINATE_EPSILON || side * waterSideSign > 0;
    }
  }

  return nearestIsWater || nearestDistanceSquared <= clearanceM * clearanceM;
}

function crossProduct(
  start: LocalObstaclePoint,
  end: LocalObstaclePoint,
  point: LocalObstaclePoint
): number {
  return (end.x - start.x) * (point.z - start.z) - (end.z - start.z) * (point.x - start.x);
}

function isFiniteLocalPoint(point: LocalObstaclePoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.z);
}

function shortestLongitudeDelta(delta: number): number {
  return ((delta + 540) % 360) - 180;
}

function normalizeLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

function polygonBounds(points: readonly LocalObstaclePoint[]): LocalObstacleBounds {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minZ: Math.min(...points.map((point) => point.z)),
    maxZ: Math.max(...points.map((point) => point.z)),
  };
}

function polygonSignedArea(points: readonly LocalObstaclePoint[]): number {
  let doubledArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubledArea += current.x * next.z - next.x * current.z;
  }
  return doubledArea / 2;
}

function pointTouchesPolygon(
  point: LocalObstaclePoint,
  polygon: readonly LocalObstaclePoint[],
  clearanceM: number
): boolean {
  if (pointInPolygon(point, polygon)) return true;
  const clearanceSquared = clearanceM * clearanceM;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    if (distanceToSegmentSquared(point, start, end) <= clearanceSquared) return true;
  }
  return false;
}

function pointInPolygon(
  point: LocalObstaclePoint,
  polygon: readonly LocalObstaclePoint[]
): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const a = polygon[current];
    const b = polygon[previous];
    const crosses =
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegmentSquared(
  point: LocalObstaclePoint,
  start: LocalObstaclePoint,
  end: LocalObstaclePoint
): number {
  const segmentX = end.x - start.x;
  const segmentZ = end.z - start.z;
  const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
  if (lengthSquared === 0) return squaredDistance(point, start);
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * segmentX + (point.z - start.z) * segmentZ) / lengthSquared)
  );
  return squaredDistance(point, {
    x: start.x + projection * segmentX,
    z: start.z + projection * segmentZ,
  });
}

function squaredDistance(left: LocalObstaclePoint, right: LocalObstaclePoint): number {
  const deltaX = left.x - right.x;
  const deltaZ = left.z - right.z;
  return deltaX * deltaX + deltaZ * deltaZ;
}

function containsExpanded(
  bounds: LocalObstacleBounds,
  point: LocalObstaclePoint,
  expansion: number
): boolean {
  return (
    point.x >= bounds.minX - expansion &&
    point.x <= bounds.maxX + expansion &&
    point.z >= bounds.minZ - expansion &&
    point.z <= bounds.maxZ + expansion
  );
}

function cellCoordinate(value: number): number {
  return Math.floor(value / GRID_CELL_SIZE_M);
}

function cellKey(x: number, z: number): string {
  return `${x}:${z}`;
}

function sameGeoPoint(left: GeoCoordinate, right: GeoCoordinate): boolean {
  return (
    Math.abs(left.lat - right.lat) <= COORDINATE_EPSILON &&
    Math.abs(left.lon - right.lon) <= COORDINATE_EPSILON
  );
}

function cacheKey(lat: number, lon: number, radiusM: number): string {
  return `${CACHE_PREFIX}:${lat.toFixed(CACHE_COORD_PRECISION)}:${lon.toFixed(
    CACHE_COORD_PRECISION
  )}:${Math.round(radiusM)}`;
}

function readCache(key: string): CachedObstacleResult | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || typeof value.savedAt !== 'number') {
      throw new Error('Cached obstacle payload was malformed');
    }
    const age = Date.now() - value.savedAt;
    if (!Number.isFinite(value.savedAt) || age < -CACHE_TTL_MS) {
      throw new Error('Cached obstacle payload timestamp was invalid');
    }
    if (
      !Array.isArray(value.polygons) ||
      value.polygons.length >= MAX_POLYGONS ||
      !Array.isArray(value.coastlines) ||
      value.coastlines.length >= MAX_COASTLINES
    ) {
      throw new Error('Cached obstacle payload exceeded safety limits');
    }

    const polygons = value.polygons.map((polygon) => readCachedPolygon(polygon));
    let coastlineVertices = 0;
    const coastlines = value.coastlines.map((coastline) => {
      const parsed = readCachedCoastline(coastline);
      coastlineVertices += parsed.points.length;
      if (coastlineVertices >= MAX_TOTAL_COASTLINE_VERTICES) {
        throw new Error('Cached coastlines exceeded the total vertex limit');
      }
      return parsed;
    });
    const data = Object.freeze({
      polygons: Object.freeze(polygons),
      coastlines: Object.freeze(coastlines),
    });
    return Object.freeze({
      data,
      freshness: age <= CACHE_TTL_MS ? 'fresh' : 'stale',
    });
  } catch {
    removeCache(key);
    return null;
  }
}

function readCachedPolygon(value: unknown): GeoObstaclePolygon {
  if (!isRecord(value) || (value.kind !== 'building' && value.kind !== 'water')) {
    throw new Error('Cached obstacle polygon was malformed');
  }
  const rawPoints = readGeoCoordinates(value.points, 'cached obstacle polygon');
  if (!rawPoints) throw new Error('Cached obstacle polygon omitted points');
  const points = sanitizeGeoRing(rawPoints);
  if (points.length < 3) throw new Error('Cached obstacle polygon was degenerate');
  return Object.freeze({ kind: value.kind, points: Object.freeze(points) });
}

function readCachedCoastline(value: unknown): GeoCoastline {
  if (!isRecord(value)) throw new Error('Cached coastline was malformed');
  const rawPoints = readGeoCoordinates(value.points, 'cached coastline');
  if (!rawPoints) throw new Error('Cached coastline omitted points');
  return Object.freeze({ points: Object.freeze(sanitizeGeoLine(rawPoints, 'cached coastline')) });
}

function removeCache(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage is optional in privacy-restricted browser contexts.
  }
}

function writeCache(key: string, obstacleData: GeoObstacleData): void {
  try {
    const payload: CachedObstaclePayload = {
      savedAt: Date.now(),
      polygons: obstacleData.polygons,
      coastlines: obstacleData.coastlines,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Caching is opportunistic; obstacle safety still uses the in-memory response.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
