import { getLocalStorageItem, setLocalStorageItem } from './safeStorage';

export const SPAWN_STORAGE_KEY = 'spawn_location_key';

export const SPAWN_LOCATIONS = [
  {
    key: 'manhattan',
    label: 'Manhattan, New York',
    description: 'Times Square / Midtown skyscrapers',
    lat: 40.7580,
    lon: -73.9855,
  },
  {
    key: 'san_francisco',
    label: 'San Francisco',
    description: 'Golden Gate + Financial District',
    lat: 37.7955,
    lon: -122.3937,
  },
  {
    key: 'singapore',
    label: 'Singapore',
    description: 'Marina Bay Sands skyline',
    lat: 1.2868,
    lon: 103.8545,
  },
  {
    key: 'sydney',
    label: 'Sydney Opera House',
    description: 'Harbour city landmark',
    lat: -33.8568,
    lon: 151.2153,
  },
  {
    key: 'tokyo_shibuya',
    label: 'Shibuya Crossing, Tokyo',
    description: 'High-energy urban streets',
    lat: 35.6595,
    lon: 139.7005,
  },
];

export function getStoredSpawnKey(): string {
  return getLocalStorageItem(SPAWN_STORAGE_KEY) ?? 'manhattan';
}

export function setStoredSpawnKey(key: string): void {
  setLocalStorageItem(SPAWN_STORAGE_KEY, key);
  window.dispatchEvent(new CustomEvent('spawnLocationChanged', { detail: key }));
}
