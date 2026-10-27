import type { ThemePref } from './types'

const CACHE_KEY = 'rc.theme'
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')

/** Set data-theme="light" | "dark" on <html>; "system" follows the OS. */
export function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && darkQuery().matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

/** Follow OS theme changes while the preference is "system". Returns an unsubscribe. */
export function watchSystemTheme(pref: ThemePref): () => void {
  if (pref !== 'system') return () => {}
  const q = darkQuery()
  const onChange = () => applyTheme('system')
  q.addEventListener('change', onChange)
  return () => q.removeEventListener('change', onChange)
}

// The setting lives in the backend, which takes a few seconds to start. This local copy
// lets the first paint use the right theme instead of flashing the wrong one.
export function cachedTheme(): ThemePref {
  try {
    const v = localStorage.getItem(CACHE_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function cacheTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(CACHE_KEY, pref)
  } catch {
    /* storage unavailable: the theme still applies, it just isn't cached */
  }
}
