import { createRoot } from 'react-dom/client';
import { setBaseUrl } from '@workspace/api-client-react';

import App from './App';

// API requests go through the artifact's base path so routing works
// regardless of where the app is mounted (e.g. `/api/v1/...`).
setBaseUrl(import.meta.env.BASE_URL.replace(/\/+$/, '') || null);

import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
