import '@fontsource/rajdhani/400.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource/space-mono/400.css';
import '@fontsource/space-mono/700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/global.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div data-testid="gui-root">Aether GUI</div>
  </StrictMode>,
);
