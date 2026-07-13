import { PerspectiveCamera, Scene } from 'three';

import { renderTilesOnlyFrame } from '../../../../features/sandbox/engine/createSandbox';

describe('renderTilesOnlyFrame', () => {
  it('renders layer zero and restores overlay layers before returning', () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    camera.layers.enable(1);
    const originalMask = camera.layers.mask;
    const render = vi.fn(() => {
      expect(camera.layers.isEnabled(0)).toBe(true);
      expect(camera.layers.isEnabled(1)).toBe(false);
    });

    renderTilesOnlyFrame({ render }, scene, camera);

    expect(render).toHaveBeenCalledWith(scene, camera);
    expect(camera.layers.mask).toBe(originalMask);
    expect(camera.layers.isEnabled(1)).toBe(true);
  });

  it('restores overlays even when rendering throws', () => {
    const camera = new PerspectiveCamera();
    camera.layers.enable(1);
    const originalMask = camera.layers.mask;
    const failure = new Error('render failed');

    expect(() =>
      renderTilesOnlyFrame(
        {
          render: () => {
            throw failure;
          },
        },
        new Scene(),
        camera
      )
    ).toThrow(failure);
    expect(camera.layers.mask).toBe(originalMask);
  });
});
