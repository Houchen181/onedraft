import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => console.error(`OneDraft UI crashed: ${String(error)}
${info.componentStack ?? ''}`)
}).render(
  <StrictMode>
    <App />
  </StrictMode>
)
