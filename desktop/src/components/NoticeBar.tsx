/** Something that finished while the writer was somewhere else in the app. */
export interface BarNotice {
  id: string
  text: string
  action?: { label: string; run: () => void }
}

/** A slim dark line across the window, under the app bar: one sentence, one link, a close button. For
 * what finished elsewhere (checks, a matrix, an import, an update), one at a time; it stays until
 * it's dismissed or its link is followed. Quick confirmations still use the toast at the bottom. */
export function NoticeBar({ notice, onClose }: { notice: BarNotice | null; onClose: () => void }) {
  return (
    <div className="notice-slot" role="status" aria-live="polite">
      {notice && (
        <div className="notice-bar" key={notice.id}>
          <span>
            {notice.text}{' '}
            {notice.action && (
              <button
                className="notice-link"
                onClick={() => {
                  notice.action!.run()
                  onClose()
                }}
              >
                {notice.action.label} ›
              </button>
            )}
          </span>
          <button className="notice-x" onClick={onClose} aria-label="Dismiss" title="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  )
}
