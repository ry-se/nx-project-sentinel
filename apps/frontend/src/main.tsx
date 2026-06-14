import { BrowserRouter } from 'react-router-dom';
import * as ReactDOM from 'react-dom/client';

import App from './app/app';
import { NavBar } from './layouts/NavBar';

// Tile caching is DISABLED. The cache-first service worker served stale /
// partial tiles forever (geometry that got cached mid-stream never re-fetched),
// which broke 3D-tile streaming away from spawn. Purge any previously-installed
// worker + its cache so streaming behaves normally again.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister()
  })
}
if ('caches' in window) {
  void caches.keys().then((names) => {
    for (const name of names) if (name.startsWith('sentinel-tiles')) void caches.delete(name)
  })
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

root.render(
  <BrowserRouter>
    <NavBar />
    <App />
  </BrowserRouter>
);
