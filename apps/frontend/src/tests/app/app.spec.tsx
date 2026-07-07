import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { App } from '../../app/app';

vi.mock('../../features/sandbox/WorldView', () => ({
  WorldView: () => <div data-testid="world-view-mock" />,
}));

vi.mock('../../features/sandbox/intel/DetectDebug', () => ({
  DetectDebug: () => <div data-testid="detect-debug-mock" />,
}));

describe('App', () => {
  it('routes / to the sandbox world view', async () => {
    render(
      <MemoryRouter
        initialEntries={['/']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByTestId('world-view-mock')).toBeInTheDocument();
  });

  it('routes /detect-debug to the debug chunk', async () => {
    render(
      <MemoryRouter
        initialEntries={['/detect-debug']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByTestId('detect-debug-mock')).toBeInTheDocument();
  });
});
