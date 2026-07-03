import { Route, Routes } from 'react-router-dom';

import { DetectDebug } from '../features/sandbox/intel/DetectDebug';
import { WorldView } from '../features/sandbox/WorldView';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<WorldView />} />
      <Route path="/detect-debug" element={<DetectDebug />} />
    </Routes>
  );
}
