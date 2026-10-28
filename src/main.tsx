import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { loadApi } from './api'
import './index.css'

const api = await loadApi()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>
)
