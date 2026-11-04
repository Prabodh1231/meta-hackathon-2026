import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ReaderWindow } from './components/ReaderDialog'
import { applyTheme, cachedTheme } from './theme'
import './styles.css'

applyTheme(cachedTheme())

const params = new URLSearchParams(window.location.search)
const reader = params.get('reader')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The desktop app opens a paper's reader in a window of its own: the same page, with ?reader=<id>. */}
    {reader ? <ReaderWindow docId={Number(reader)} page={Number(params.get('page')) || 1} /> : <App />}
  </StrictMode>,
)
