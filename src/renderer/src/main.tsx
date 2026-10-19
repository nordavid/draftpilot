import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/barlow/400.css'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow-semi-condensed/600.css'
import '@fontsource/barlow-semi-condensed/700.css'
import App from './App'
import './index.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
