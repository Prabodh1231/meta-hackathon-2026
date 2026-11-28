import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ReaderWindow } from './components/ReaderDialog'
import { applyTheme, cachedTheme } from './theme'
import { markFrameless } from './titleBar'
import './styles.css'
import './design.css'
import './libraryFolders.css'
import './writeTools.css'

applyTheme(cachedTheme())

const params = new URLSearchParams(window.location.search)
const reader = params.get('reader')
// Before the first frame: the app bar is the window's title bar (titleBar.ts); the reader keeps its frame
if (!reader) markFrameless()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {/* The desktop app opens a paper's reader in a window of its own: the same page, with ?reader=<id>. */}
      {reader ? <ReaderWindow docId={Number(reader)} page={Number(params.get('page')) || 1} find={params.get('find') ?? undefined} /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
)

// Once the first frame is on screen, the desktop app shows the window: shown before, it flashed white
// (or the other theme) while the page loaded. Two frames: the first is when React's work is painted.
requestAnimationFrame(() => requestAnimationFrame(() => window.rc?.painted?.()))
