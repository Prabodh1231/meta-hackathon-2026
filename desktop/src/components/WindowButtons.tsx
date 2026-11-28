import { useEffect, useState } from 'react'

/** The window's minimise, maximise (restore, once maximised) and close, at the right end of the app bar
 * (and of focus mode's strip), drawn by the app on Windows and Linux. Windows' own buttons drew a hover the
 * app couldn't colour, too faint to see in the light theme; these hover in the theme's text colour, and
 * close in red, as Windows does. Nothing on the Mac, which keeps its own. */
export function WindowButtons() {
  const controls = window.rc?.windowControls
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!controls) return
    controls
      .isMaximized()
      .then(setMaximized)
      .catch(() => {})
    return controls.onMaximized(setMaximized)
  }, [controls])
  if (!controls) return null
  return (
    <div className="win-buttons">
      <button className="win-btn" onClick={() => controls.minimize()} aria-label="Minimise" title="Minimise">
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button className="win-btn" onClick={() => controls.toggleMaximize()} aria-label={maximized ? 'Restore' : 'Maximise'} title={maximized ? 'Restore' : 'Maximise'}>
        <svg viewBox="0 0 10 10" aria-hidden="true">
          {maximized ? <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /> : <path d="M.5 .5h9v9h-9z" />}
        </svg>
      </button>
      <button className="win-btn win-close" onClick={() => controls.close()} aria-label="Close" title="Close">
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M.5 .5l9 9M9.5 .5l-9 9" />
        </svg>
      </button>
    </div>
  )
}
