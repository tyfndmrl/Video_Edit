import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { installTestBridge } from './state/testBridge';
import './index.css';

// DEV'de E2E köprüsünü yayımla (üretimde gövdesi ölü kod — bkz. testBridge.ts).
// Render'dan ÖNCE: köprü, sayfa boyanmadan önce hazır olmalı.
installTestBridge();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

// ErrorBoundary EN DIŞTA: sınır olmadan, render/commit sırasında fırlayan tek
// bir hata React'in kök ağacı sökmesine — yani BEYAZ EKRANA — yol açar.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
