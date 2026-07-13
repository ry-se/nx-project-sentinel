import {
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three';

import {
  BattleSimulationController,
  type BattleScenarioId,
} from '../../../../features/sandbox/engine/battleSimulation';
import type {
  ProjectedIntelContact,
  SentinelDetection,
} from '../../../../features/sandbox/engine/detections';
import type { ModelLibrary } from '../../../../features/sandbox/engine/modelCatalog';
import type {
  TerrainSemanticsSummary,
  TerrainSurfaceClass,
} from '../../../../features/sandbox/engine/terrainSemantics';

function createModelLibraryStub(): ModelLibrary {
  return {
    instance: (_id: string, fallback: () => Group): Group => fallback(),
  } as unknown as ModelLibrary;
}

function createFlatTerrain(): Mesh {
  const terrain = new Mesh(
    new PlaneGeometry(2_000, 2_000),
    new MeshBasicMaterial({ color: 0x333333 })
  );
  terrain.rotation.x = -Math.PI / 2;
  terrain.updateMatrixWorld(true);
  return terrain;
}

function createDropCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 1_000);
  camera.position.set(0, 100, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function createDropCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    right: 100,
    bottom: 100,
    left: 0,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  });
  return canvas;
}

function terrainProvider(
  classify: (x: number, z: number, clearanceM: number) => TerrainSurfaceClass,
  status: TerrainSemanticsSummary['status'] = 'ready'
): {
  classifyWorld: (
    position: { readonly x: number; readonly z: number },
    clearanceM: number
  ) => TerrainSurfaceClass;
  readonly summary: TerrainSemanticsSummary;
} {
  return {
    classifyWorld: (position, clearanceM) => classify(position.x, position.z, clearanceM),
    summary: {
      status,
      buildingCount: 1,
      waterCount: 1,
      message: status === 'ready' ? 'Terrain ready' : 'Terrain unavailable',
    },
  };
}

describe('BattleSimulationController', () => {
  it('runs without example units once both forces have operator deployments', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => 'clear')
    );

    const blue = controller.importIntelContacts(
      'none',
      { teamId: 'blue', order: 'hold' },
      [projectedContact('blue-custom', 'armored_fighting_vehicle', { x: -30, y: 0, z: -30 })],
      new Vector3()
    );

    expect(blue.snapshot?.units.map((unit) => unit.id)).toEqual(['intel-blue-custom']);
    expect(() => controller.startScenario('none', new Vector3())).toThrow(
      /one Blue Force unit and one Red Force unit/i
    );

    const red = controller.importIntelContacts(
      'none',
      { teamId: 'red', order: 'pursue' },
      [projectedContact('red-custom', 'light_military_vehicle', { x: 30, y: 0, z: 30 })],
      new Vector3()
    );
    const running = controller.startScenario('none', new Vector3());

    expect(red.snapshot?.units.map((unit) => unit.id)).toEqual([
      'intel-blue-custom',
      'intel-red-custom',
    ]);
    expect(running).toMatchObject({ scenarioId: 'none', scenarioName: 'Custom Battle' });
    expect(running.units.map((unit) => unit.id)).toEqual([
      'intel-blue-custom',
      'intel-red-custom',
    ]);
    controller.dispose();
  });

  it.each<BattleScenarioId>(['armored-skirmish', 'combined-arms'])(
    'renders and advances the %s example without coupling terrain to simulation state',
    (scenarioId) => {
      const scene = new Scene();
      const terrain = createFlatTerrain();
      scene.add(terrain);
      const controller = new BattleSimulationController(scene, terrain, createModelLibraryStub());

      const initial = controller.startScenario(scenarioId, new Vector3(0, 10, 0));
      const root = scene.getObjectByName('battle-simulation');
      expect(root).toBeDefined();
      expect(root?.children).toHaveLength(initial.units.length);

      const firstGroundUnit = initial.units.find((unit) => unit.type !== 'jet');
      expect(firstGroundUnit).toBeDefined();
      const renderedGroundUnit = scene.getObjectByName(`battle-unit-${firstGroundUnit?.id ?? ''}`);
      const worldPosition = renderedGroundUnit?.getWorldPosition(new Vector3());
      expect(worldPosition?.y).toBeGreaterThanOrEqual(0);
      expect(worldPosition?.y).toBeLessThan(1);

      const firstJet = initial.units.find((unit) => unit.type === 'jet');
      if (firstJet) {
        const renderedJet = scene.getObjectByName(`battle-unit-${firstJet.id}`);
        expect(renderedJet?.getWorldPosition(new Vector3()).y).toBeCloseTo(firstJet.position.y, 5);
      }

      const advanced = controller.update(0.05);
      expect(advanced?.tick).toBe(1);

      controller.setPaused(true);
      const pausedTick = controller.getSnapshot()?.tick;
      controller.update(0.2);
      expect(controller.getSnapshot()?.tick).toBe(pausedTick);

      controller.setPaused(false);
      controller.setTimeScale(2);
      controller.update(0.05);
      expect(controller.getSnapshot()?.tick).toBe((pausedTick ?? 0) + 2);

      const restarted = controller.restart();
      expect(restarted?.tick).toBe(0);
      expect(restarted?.status.phase).toBe('running');

      controller.stop();
      expect(root?.children).toHaveLength(0);
      controller.dispose();
      expect(scene.getObjectByName('battle-simulation')).toBeUndefined();
    }
  );

  it.each([
    ['building', 'building'],
    ['water', 'water'],
  ] as const)('rejects a ground-unit drop classified as %s', (surface, reason) => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => surface)
    );

    const result = controller.placeUnit(
      'armored-skirmish',
      'blue',
      'tank',
      50,
      50,
      createDropCamera(),
      createDropCanvas(),
      new Vector3()
    );

    expect(result).toMatchObject({ accepted: false, reason, manualUnitCount: 0 });
    expect(result.snapshot).toBeNull();
    controller.dispose();
  });

  it('accepts unknown terrain in limited mode without disabling mapped obstacle checks', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => 'unknown', 'loading')
    );

    const result = controller.placeUnit(
      'armored-skirmish',
      'blue',
      'tank',
      50,
      50,
      createDropCamera(),
      createDropCanvas(),
      new Vector3()
    );

    expect(result).toMatchObject({
      accepted: true,
      terrainConfidence: 'limited',
      manualUnitCount: 1,
    });
    expect(scene.getObjectByName(`battle-unit-${result.unitId ?? ''}`)).toBeDefined();
    controller.dispose();
  });

  it('accepts an exact clear drop, prepares it visibly, and preserves it for Run', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => 'clear')
    );

    const placed = controller.placeUnit(
      'armored-skirmish',
      'blue',
      'tank',
      50,
      50,
      createDropCamera(),
      createDropCanvas(),
      new Vector3()
    );

    expect(placed).toMatchObject({ accepted: true, manualUnitCount: 1 });
    expect(placed.snapshot?.status.phase).toBe('ready');
    const deployed = placed.snapshot?.units.find((unit) => unit.id === placed.unitId);
    expect(deployed?.position.x).toBeCloseTo(0, 5);
    expect(deployed?.position.z).toBeCloseTo(0, 5);
    expect(scene.getObjectByName(`battle-unit-${placed.unitId ?? ''}`)).toBeDefined();

    const running = controller.startScenario('armored-skirmish', new Vector3());
    expect(running.status.phase).toBe('running');
    expect(running.units.some((unit) => unit.id === placed.unitId)).toBe(true);

    const locked = controller.placeUnit(
      'armored-skirmish',
      'red',
      'car',
      50,
      50,
      createDropCamera(),
      createDropCanvas(),
      new Vector3()
    );
    expect(locked).toMatchObject({ accepted: false, reason: 'battle-running' });

    controller.setPaused(true);
    const pausedLocked = controller.placeUnit(
      'armored-skirmish',
      'red',
      'car',
      50,
      50,
      createDropCamera(),
      createDropCanvas(),
      new Vector3()
    );
    expect(pausedLocked).toMatchObject({ accepted: false, reason: 'battle-running' });
    controller.stop();
    expect(controller.getSnapshot()?.status.phase).toBe('ready');
    expect(scene.getObjectByName(`battle-unit-${placed.unitId ?? ''}`)).toBeDefined();
    controller.dispose();
  });

  it('starts and advances in limited mode while semantic terrain is unavailable', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => 'unknown', 'loading')
    );

    const started = controller.startScenario('combined-arms', new Vector3());
    expect(started.status.phase).toBe('running');
    expect(controller.update(0.05)?.tick).toBe(1);
    controller.dispose();
  });

  it('renders accepted units immediately even when unrelated template units cannot be arranged', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider((x, z) => (Math.hypot(x, z) < 1 ? 'clear' : 'building'))
    );

    const placed = controller.placeUnit(
      'armored-skirmish',
      'blue',
      'tank',
      50,
      50,
      createDropCamera(),
      createDropCanvas(),
      new Vector3(0, 2_000, 0)
    );

    expect(placed.accepted).toBe(true);
    expect(placed.snapshot?.units.map((unit) => unit.id)).toEqual([placed.unitId]);
    const rendered = scene.getObjectByName(`battle-unit-${placed.unitId ?? ''}`);
    expect(rendered).toBeDefined();
    expect(rendered?.getWorldPosition(new Vector3()).y).toBeLessThan(1);
    controller.dispose();
  });

  it('renders a jet immediately during terrain loading and grounds the battle origin', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => 'unknown', 'loading')
    );

    const placed = controller.placeUnit(
      'combined-arms',
      'red',
      'jet',
      50,
      50,
      createDropCamera(),
      createDropCanvas(),
      new Vector3(0, 2_000, 0)
    );

    expect(placed.accepted).toBe(true);
    const rendered = scene.getObjectByName(`battle-unit-${placed.unitId ?? ''}`);
    expect(rendered).toBeDefined();
    expect(rendered?.getWorldPosition(new Vector3()).y).toBeCloseTo(90, 5);
    controller.dispose();
  });

  it('links projected intel into visible battle units with provenance-safe ids and orders', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => 'clear')
    );
    const contacts = [
      projectedContact('afv-1', 'armored_fighting_vehicle', { x: 12, y: 0, z: 18 }, 0.7),
      projectedContact('air-1', 'aircraft', { x: 40, y: 0, z: 42 }, -0.4),
    ];

    const imported = controller.importIntelContacts(
      'combined-arms',
      { teamId: 'red', order: 'hold' },
      contacts,
      new Vector3()
    );

    expect(imported.acceptedIds).toEqual(['afv-1', 'air-1']);
    expect(imported.deploymentCount).toBe(2);
    expect(imported.snapshot?.units.find((unit) => unit.id === 'intel-afv-1')).toMatchObject({
      type: 'tank',
      teamId: 'red',
      order: { kind: 'hold' },
      heading: 0.7,
    });
    expect(scene.getObjectByName('battle-unit-intel-afv-1')).toBeDefined();
    expect(scene.getObjectByName('battle-unit-intel-air-1')).toBeDefined();

    const duplicate = controller.importIntelContacts(
      'combined-arms',
      { teamId: 'red', order: 'hold' },
      contacts,
      new Vector3()
    );
    expect(duplicate.acceptedIds).toEqual([]);
    expect(duplicate.duplicateIds).toEqual(['afv-1', 'air-1']);
    expect(duplicate.deploymentCount).toBe(2);

    controller.startScenario('combined-arms', new Vector3());
    const duringRun = controller.importIntelContacts(
      'combined-arms',
      { teamId: 'red', order: 'pursue' },
      [projectedContact('late-1', 'light_military_vehicle', { x: 80, y: 0, z: 80 })],
      new Vector3()
    );
    expect(duringRun.acceptedIds).toEqual([]);
    expect(duringRun.held[0]?.reason).toMatch(/stop the active battle/i);
    expect(scene.getObjectByName('battle-unit-intel-late-1')).toBeUndefined();
    controller.dispose();
  });

  it('holds imported ground intel on mapped water but accepts aircraft', () => {
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => 'water')
    );

    const imported = controller.importIntelContacts(
      'combined-arms',
      { teamId: 'red', order: 'hold' },
      [
        projectedContact('afv-water', 'armored_fighting_vehicle', { x: 10, y: 0, z: 10 }),
        projectedContact('air-water', 'aircraft', { x: 30, y: 0, z: 30 }),
      ],
      new Vector3()
    );

    expect(imported.acceptedIds).toEqual(['air-water']);
    expect(imported.held).toEqual([
      expect.objectContaining({
        detectionId: 'afv-water',
        reason: expect.stringMatching(/water/i),
      }),
    ]);
    expect(scene.getObjectByName('battle-unit-intel-air-water')).toBeDefined();
    controller.dispose();
  });

  it('consults semantic passability during ground movement', () => {
    let queryCount = 0;
    const scene = new Scene();
    const terrain = createFlatTerrain();
    scene.add(terrain);
    const controller = new BattleSimulationController(
      scene,
      terrain,
      createModelLibraryStub(),
      terrainProvider(() => {
        queryCount += 1;
        return 'clear';
      })
    );

    controller.startScenario('armored-skirmish', new Vector3());
    queryCount = 0;
    controller.update(0.05);

    expect(queryCount).toBeGreaterThan(0);
    controller.dispose();
  });
});

function projectedContact(
  detectionId: string,
  cls: SentinelDetection['class'],
  worldPosition: { readonly x: number; readonly y: number; readonly z: number },
  localHeadingRad?: number
): ProjectedIntelContact {
  const detection: SentinelDetection = {
    detection_id: detectionId,
    image_id: 'image-1',
    class: cls,
    confidence: 0.9,
    bbox_pixel: { x: 0, y: 0, w: 10, h: 5, theta: 0 },
    lat: 1.35,
    lon: 103.8,
    world_heading: 0,
    heading_confidence: 'high',
    timestamp: '2026-07-10T00:00:00.000Z',
    source_image_url: 'intel.png',
    method: 'auto',
    model: 'test-model',
  };
  return {
    detection,
    worldPosition,
    ...(localHeadingRad === undefined ? {} : { localHeadingRad }),
  };
}
