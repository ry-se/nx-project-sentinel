// Uncomment this line to use CSS modules
// import styles from './app.module.css';
import { useEffect, useState } from 'react';

import { WorldView } from '../features/sandbox/WorldView';

export function App() {
  const [data, setData] = useState(null);
  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/');
        const data = await res.json();
        console.error(data);
        setData(data.message);
      } catch (err) {
        console.error(err);
      }
    };

    void fetchData();
  }, []);

  return (
    <div>
      <h1>The data returned is {data}</h1>
      <WorldView />
    </div>
  );
}

export default App;
