import React from 'react';
import ReactDOM from 'react-dom/client';
import AtlasApp from '@plannotator/atlas';
import { AtlasWorkerPoolProvider } from '@plannotator/atlas/worker-pool';
import '@plannotator/atlas/styles';

const root = document.getElementById('root');
if (!root) throw new Error('Could not find root element');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AtlasWorkerPoolProvider>
      <AtlasApp />
    </AtlasWorkerPoolProvider>
  </React.StrictMode>,
);
