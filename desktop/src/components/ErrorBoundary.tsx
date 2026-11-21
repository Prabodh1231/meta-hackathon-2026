import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Catches an error thrown while drawing the app, which would otherwise leave an empty window.
 * Drafts are saved as they're typed, so reloading brings the work back. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Groundwork stopped drawing:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>Groundwork hit an error and can’t show this window. Your drafts are saved as you type, so reloading brings your work back.</p>
        <button className="primary" autoFocus onClick={() => window.location.reload()}>
          Reload
        </button>
        <details>
          <summary>Error details</summary>
          <pre>{error.stack || String(error)}</pre>
        </details>
      </div>
    )
  }
}

/** The same for one place in the app (the Network): an error there, or its code failing to load,
 * shows in that place while the rest of the window, the draft included, keeps working. Before, it
 * took the whole window down. `beforeReload` saves what's pending (the last typing) first. */
export class PaneBoundary extends Component<
  { what: string; beforeReload?: () => Promise<unknown>; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Groundwork could not show ${this.props.what}:`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const reload = async () => {
      await this.props.beforeReload?.().catch(() => {})
      window.location.reload()
    }
    return (
      <div className="crash pane-crash" role="alert">
        <h2>Couldn’t show {this.props.what}</h2>
        <p>The rest of Groundwork still works. Reloading usually fixes this, and your drafts are saved first.</p>
        <button className="primary" onClick={reload}>
          Reload
        </button>
        <details>
          <summary>Error details</summary>
          <pre>{error.stack || String(error)}</pre>
        </details>
      </div>
    )
  }
}
