/* eslint-disable import/first */
import { Ion } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

import { BrowserRouter } from 'react-router-dom';
import * as ReactDOM from 'react-dom/client';

import App from './app/app';
import { NavBar } from './layouts/NavBar';

Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ACCESS_TOKEN || '';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

root.render(
  <BrowserRouter>
    <NavBar />
    <App />
  </BrowserRouter>
);