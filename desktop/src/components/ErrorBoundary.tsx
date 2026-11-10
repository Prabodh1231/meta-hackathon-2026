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
