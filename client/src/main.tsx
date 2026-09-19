import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ModelCompass from './ModelCompass.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ModelCompass />
  </StrictMode>,
)
