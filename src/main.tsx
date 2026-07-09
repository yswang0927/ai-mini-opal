import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App';
import { L10nProvider } from "@/l10n";

import './index.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <L10nProvider>
      <App />
    </L10nProvider>
  </React.StrictMode>
)

postMessage({ payload: 'removeLoading' }, '*');

// Use contextBridge
window.ipcRenderer.on('main-process-message', (_event, message) => {
  console.log(message)
});
