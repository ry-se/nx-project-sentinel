import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

import App from './app';

vi.mock('../features/sandbox/WorldView', () => ({
  WorldView: () => <div data-testid="world-view-mock" />,
}));

describe('App', () => {
  it('should render successfully', () => {
    const { baseElement } = render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    );
    expect(baseElement).toBeTruthy();
  });

  it('should have a greeting as the title', () => {
    const { getByTestId } = render(
      <BrowserRouter>
        <App />
      </BrowserRouter>
    );
    expect(getByTestId('world-view-mock')).toBeTruthy();
  });
});
