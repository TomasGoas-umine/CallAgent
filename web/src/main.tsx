import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('umine-voice-root');
if (!container) {
  throw new Error('No se encontro #umine-voice-root en el DOM');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
