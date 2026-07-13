import { Vector3 } from 'three';

import {
  SemanticObstacleMap,
  TerrainSemanticIndex,
  type LocalCoastline,
  type LocalObstacleBounds,
  type LocalObstaclePolygon,
} from '../../../../features/sandbox/engine/terrainSemantics';
import type { GeoFrame, GeoPosition } from '../../../../features/sandbox/engine/geoFrame';

const COVERAGE: LocalObstacleBounds = {
  minX: -100,
  maxX: 100,
  minZ: -100,
  maxZ: 100,
};

const PRIMARY_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const MAIL_OVERPASS_ENDPOINT = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';

const OBSTACLES: readonly LocalObstaclePolygon[] = [
  {
    kind: 'building',
    points: [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 0, z: 10 },
    ],
  },
  {
    kind: 'water',
    points: [
      { x: -30, z: -20 },
      { x: -10, z: -20 },
      { x: -10, z: -5 },
      { x: -30, z: -5 },
    ],
  },
];

describe('SemanticObstacleMap', () => {
  const map = new SemanticObstacleMap(OBSTACLES, COVERAGE);

  it('classifies mapped building and water interiors', () => {
    expect(map.classify({ x: 5, z: 5 }, 0)).toBe('building');
    expect(map.classify({ x: -20, z: -10 }, 0)).toBe('water');
  });

  it('inflates obstacles by the unit footprint clearance', () => {
    expect(map.classify({ x: 12, z: 5 }, 1)).toBe('clear');
    expect(map.classify({ x: 12, z: 5 }, 2.1)).toBe('building');
  });

  it('treats positions outside known coverage as unknown rather than clear', () => {
    expect(map.classify({ x: 50, z: 50 }, 4)).toBe('clear');
    expect(map.classify({ x: 99, z: 0 }, 4)).toBe('unknown');
    expect(map.classify({ x: 110, z: 0 }, 0)).toBe('unknown');
  });

  it('reports semantic feature counts', () => {
    expect(map.counts).toEqual({ buildings: 1, water: 1 });
  });

  it('gives buildings precedence over overlapping water independent of input order', () => {
    const building = OBSTACLES[0];
    const water: LocalObstaclePolygon = {
      kind: 'water',
      points: [
        { x: -5, z: -5 },
        { x: 15, z: -5 },
        { x: 15, z: 15 },
        { x: -5, z: 15 },
      ],
    };

    expect(new SemanticObstacleMap([water, building], COVERAGE).classify({ x: 5, z: 5 }, 0)).toBe(
      'building'
    );
    expect(new SemanticObstacleMap([building, water], COVERAGE).classify({ x: 5, z: 5 }, 0)).toBe(
      'building'
    );
  });

  it('classifies concave polygons without treating their bounding box as filled', () => {
    const concave: LocalObstaclePolygon = {
      kind: 'building',
      points: [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
        { x: 20, z: 5 },
        { x: 5, z: 5 },
        { x: 5, z: 20 },
        { x: 0, z: 20 },
      ],
    };
    const concaveMap = new SemanticObstacleMap([concave], COVERAGE);

    expect(concaveMap.classify({ x: 2, z: 15 }, 0)).toBe('building');
    expect(concaveMap.classify({ x: 15, z: 15 }, 0)).toBe('clear');
  });

  it('uses the actual transformed coverage polygon, including clearance from its edge', () => {
    const diamondCoverage: LocalObstacleBounds = {
      minX: -10,
      maxX: 10,
      minZ: -10,
      maxZ: 10,
    };
    const diamondMap = new SemanticObstacleMap([], diamondCoverage, {
      coveragePolygon: [
        { x: 0, z: -10 },
        { x: 10, z: 0 },
        { x: 0, z: 10 },
        { x: -10, z: 0 },
      ],
    });

    expect(diamondMap.classify({ x: 0, z: 0 }, 2)).toBe('clear');
    expect(diamondMap.classify({ x: 9, z: 9 }, 0)).toBe('unknown');
    expect(diamondMap.classify({ x: 0, z: 8 }, 2)).toBe('unknown');
  });

  it('classifies the water side of an oriented coastline and inflates its land edge', () => {
    const coastlines: readonly LocalCoastline[] = [
      {
        points: [
          { x: 0, z: -100 },
          { x: 0, z: 100 },
        ],
        waterSide: 'right',
      },
    ];
    const coastlineMap = new SemanticObstacleMap([], COVERAGE, { coastlines });

    expect(coastlineMap.classify({ x: 20, z: 0 }, 0)).toBe('water');
    expect(coastlineMap.classify({ x: -20, z: 0 }, 0)).toBe('clear');
    expect(coastlineMap.classify({ x: -1, z: 0 }, 1.1)).toBe('water');
    expect(coastlineMap.counts).toEqual({ buildings: 0, water: 1 });
  });

  it('deeply copies source geometry and returns immutable summaries', () => {
    const mutablePoints = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 0, z: 10 },
    ];
    const immutableMap = new SemanticObstacleMap(
      [{ kind: 'building', points: mutablePoints }],
      COVERAGE
    );

    mutablePoints[0].x = 1_000;
    mutablePoints.push({ x: 2_000, z: 2_000 });

    expect(immutableMap.classify({ x: 1, z: 1 }, 0)).toBe('building');
    expect(Object.isFrozen(immutableMap.counts)).toBe(true);
  });

  it('fails closed for invalid map geometry', () => {
    expect(
      () =>
        new SemanticObstacleMap(
          [
            {
              kind: 'building',
              points: [
                { x: 0, z: 0 },
                { x: Number.NaN, z: 1 },
                { x: 1, z: 0 },
              ],
            },
          ],
          COVERAGE
        )
    ).toThrow(/invalid point/i);
    expect(map.classify({ x: Number.NaN, z: 0 }, 0)).toBe('unknown');
    expect(map.classify({ x: 0, z: 0 }, Number.NaN)).toBe('unknown');
  });
});

describe('TerrainSemanticIndex', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses areas and OSM-directed coastlines into immutable local semantics', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      overpassResponse({
        elements: [buildingWay(), northboundCoastline()],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const index = new TerrainSemanticIndex(fakeGeoFrame());

    await index.load(0, 0, 500);

    expect(index.summary).toMatchObject({ status: 'ready', buildingCount: 1, waterCount: 1 });
    expect(Object.isFrozen(index.summary)).toBe(true);
    expect(index.classifyWorld({ x: 20, z: 0 }, 0)).toBe('water');
    expect(index.classifyWorld({ x: -20, z: 0 }, 0)).toBe('clear');
    expect(index.classifyWorld({ x: -1, z: 0 }, 2)).toBe('water');
    expect(index.classifyWorld({ x: -40, z: 0 }, 0)).toBe('building');
  });

  it('falls back to the next public Overpass endpoint after an attempt fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(overpassErrorResponse(503))
      .mockResolvedValueOnce(overpassResponse({ elements: [buildingWay()] }));
    vi.stubGlobal('fetch', fetchMock);
    const index = new TerrainSemanticIndex(fakeGeoFrame());

    await index.load(0, 0, 500);

    expect(index.summary).toMatchObject({ status: 'ready', buildingCount: 1 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      MAIL_OVERPASS_ENDPOINT,
      PRIMARY_OVERPASS_ENDPOINT,
    ]);
  });

  it('requests relation members together with tags and geometry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      overpassResponse({
        elements: [segmentedWaterRelation()],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const index = new TerrainSemanticIndex(fakeGeoFrame());

    await index.load(0, 0, 500);

    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe('string');
    const query = new URLSearchParams(requestBody as string).get('data');
    expect(query).toMatch(/out body geom;/);
    expect(index.summary).toMatchObject({ status: 'ready', waterCount: 1 });
  });

  it('allows a valid response to use the server query budget before aborting it', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const timer = globalThis.setTimeout(
              () => resolve(overpassResponse({ elements: [buildingWay()] })),
              9_000
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                globalThis.clearTimeout(timer);
                reject(new DOMException('The operation was aborted', 'AbortError'));
              },
              { once: true }
            );
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const index = new TerrainSemanticIndex(fakeGeoFrame());

      const load = index.load(0, 0, 500);
      await vi.advanceTimersByTimeAsync(9_000);
      await load;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(index.summary).toMatchObject({ status: 'ready', buildingCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps last-good obstacle coverage active throughout a failed refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(overpassResponse({ elements: [buildingWay()] }))
      .mockRejectedValue(new Error('temporary Overpass outage'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const index = new TerrainSemanticIndex(fakeGeoFrame());
    await index.load(0, 0, 500);

    const refresh = index.load(0.01, 0, 500);
    expect(index.summary).toMatchObject({ status: 'loading', buildingCount: 1 });
    expect(index.classifyWorld({ x: -40, z: 0 }, 0)).toBe('building');

    await refresh;
    expect(index.summary.status).toBe('error');
    expect(index.summary.message).toMatch(/last-known coverage active/i);
    expect(index.classifyWorld({ x: -40, z: 0 }, 0)).toBe('building');
  });

  it('uses validated stale cache coverage when every live endpoint fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(overpassResponse({ elements: [buildingWay()] }))
      .mockRejectedValue(new Error('temporary Overpass outage'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = new TerrainSemanticIndex(fakeGeoFrame());
    await first.load(0, 0, 500);
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    if (key === null) return;
    const cached = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    cached.savedAt = Date.now() - 7 * 60 * 60 * 1_000;
    localStorage.setItem(key, JSON.stringify(cached));

    const second = new TerrainSemanticIndex(fakeGeoFrame());
    await second.load(0, 0, 500);

    expect(second.summary).toMatchObject({ status: 'error', buildingCount: 1 });
    expect(second.summary.message).toMatch(/stale cached coverage active/i);
    expect(second.classifyWorld({ x: -40, z: 0 }, 0)).toBe('building');
  });

  it('retries the last requested area and recovers after an initial outage', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('temporary Overpass outage'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const index = new TerrainSemanticIndex(fakeGeoFrame());

    await index.load(0, 0, 500);
    expect(index.summary.status).toBe('error');
    expect(index.classifyWorld({ x: -40, z: 0 }, 0)).toBe('unknown');

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(overpassResponse({ elements: [buildingWay()] }));
    await index.retry();

    expect(index.summary).toMatchObject({ status: 'ready', buildingCount: 1 });
    expect(index.classifyWorld({ x: -40, z: 0 }, 0)).toBe('building');
  });

  it('stitches reversed and unordered relation members into a water ring', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(overpassResponse({ elements: [segmentedWaterRelation()] }))
    );
    const index = new TerrainSemanticIndex(fakeGeoFrame());

    await index.load(0, 0, 500);

    expect(index.summary).toMatchObject({ status: 'ready', waterCount: 1 });
    expect(index.classifyWorld({ x: 20, z: 20 }, 0)).toBe('water');
  });

  it('reuses validated cached data without another request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(overpassResponse({ elements: [buildingWay(), northboundCoastline()] }));
    vi.stubGlobal('fetch', fetchMock);

    const first = new TerrainSemanticIndex(fakeGeoFrame());
    await first.load(0, 0, 500);
    const second = new TerrainSemanticIndex(fakeGeoFrame());
    await second.load(0, 0, 500);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.summary).toEqual(first.summary);
    expect(second.classifyWorld({ x: 20, z: 0 }, 0)).toBe('water');
  });

  it('rejects a malformed cache entry and replaces it from Overpass', async () => {
    const fetchMock = vi.fn().mockResolvedValue(overpassResponse({ elements: [buildingWay()] }));
    vi.stubGlobal('fetch', fetchMock);
    const first = new TerrainSemanticIndex(fakeGeoFrame());
    await first.load(0, 0, 500);
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    if (key === null) return;
    localStorage.setItem(
      key,
      JSON.stringify({
        savedAt: Date.now(),
        polygons: [{ kind: 'building', points: [{ lat: 'invalid', lon: 0 }] }],
        coastlines: [],
      })
    );

    const second = new TerrainSemanticIndex(fakeGeoFrame());
    await second.load(0, 0, 500);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.summary.status).toBe('ready');
    expect(second.summary.buildingCount).toBe(1);
  });

  it('aborts an older request and prevents its late response from replacing newer data', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let firstSignal: AbortSignal | null = null;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        firstSignal = init?.signal instanceof AbortSignal ? init.signal : null;
        return firstResponse;
      })
      .mockResolvedValueOnce(overpassResponse({ elements: [northboundCoastline()] }));
    vi.stubGlobal('fetch', fetchMock);
    const index = new TerrainSemanticIndex(fakeGeoFrame());

    const olderLoad = index.load(0, 0, 500);
    const newerLoad = index.load(0.01, 0, 500);
    await newerLoad;
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst?.(overpassResponse({ elements: [buildingWay()] }));
    await olderLoad;

    expect(index.summary).toMatchObject({ status: 'ready', buildingCount: 0, waterCount: 1 });
  });

  it.each([
    {
      name: 'Overpass remark',
      body: { remark: 'runtime error: Query timed out', elements: [buildingWay()] },
    },
    {
      name: 'truncated element set',
      body: { elements: Array.from({ length: 12_001 }, () => ({})) },
    },
    {
      name: 'oversized geometry',
      body: {
        elements: [
          {
            type: 'way',
            tags: { building: 'yes' },
            geometry: Array.from({ length: 4_001 }, (_, index) => ({
              lat: index / 100_000,
              lon: 0,
            })),
          },
        ],
      },
    },
  ])('fails closed for a $name', async ({ body }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(overpassResponse(body)));
    const index = new TerrainSemanticIndex(fakeGeoFrame());

    await index.load(0, 0, 500);

    expect(index.summary.status).toBe('error');
    expect(index.classifyWorld({ x: 0, z: 0 }, 0)).toBe('unknown');
  });
});

function fakeGeoFrame(): GeoFrame {
  const metresPerDegree = 111_320;
  return {
    geoToLocal: (position: GeoPosition) =>
      new Vector3(position.lon * metresPerDegree, position.altM, position.lat * metresPerDegree),
  } as unknown as GeoFrame;
}

function overpassResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function overpassErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
  } as unknown as Response;
}

function buildingWay(): unknown {
  return {
    type: 'way',
    tags: { building: 'yes' },
    geometry: [
      { lat: -0.0001, lon: -0.00045 },
      { lat: -0.0001, lon: -0.0003 },
      { lat: 0.0001, lon: -0.0003 },
      { lat: 0.0001, lon: -0.00045 },
      { lat: -0.0001, lon: -0.00045 },
    ],
  };
}

function northboundCoastline(): unknown {
  return {
    type: 'way',
    tags: { natural: 'coastline' },
    geometry: [
      { lat: -0.004, lon: 0 },
      { lat: 0.004, lon: 0 },
    ],
  };
}

function segmentedWaterRelation(): unknown {
  const a = { lat: 0.0001, lon: 0.0001 };
  const b = { lat: 0.0001, lon: 0.0003 };
  const c = { lat: 0.0003, lon: 0.0003 };
  const d = { lat: 0.0003, lon: 0.0001 };
  return {
    type: 'relation',
    tags: { natural: 'water' },
    members: [
      { role: 'outer', geometry: [a, b] },
      { role: 'outer', geometry: [d, c] },
      { role: 'outer', geometry: [c, b] },
      { role: 'outer', geometry: [d, a] },
      { role: 'inner' },
    ],
  };
}
