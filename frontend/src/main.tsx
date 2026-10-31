import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installPerf, perfMark, perfMarkNavigationStart } from './perf';
import './index.css';

perfMarkNavigationStart();
perfMark('module-loaded');
installPerf();

let serviceWorkerRegistrationStarted = false;

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const registerServiceWorker = () => {
    if (serviceWorkerRegistrationStarted) return;
    serviceWorkerRegistrationStarted = true;
    void navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    }).catch((error: unknown) => {
      console.error('Could not register the offline app worker:', error);
    });
  };

  if (document.readyState === 'complete') {
    registerServiceWorker();
  } else {
    window.addEventListener('load', registerServiceWorker, { once: true });
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
perfMark('render-requested');
