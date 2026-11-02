/** A desktop notification for a long job (a review matrix read, a proposal written) that finished
 * while the writer was elsewhere: another place in the app (`away`) or another window. Clicking it
 * brings the app back. Does nothing when the page can't notify (a plain browser that wasn't allowed). */
export function notifyDone(title: string, body: string, away = false) {
  if (!away && document.hasFocus()) return
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const n = new Notification(title, { body })
  n.onclick = () => {
    window.focus()
    n.close()
  }
}

/** "about 2 min left": what's left at the rate seen so far, or '' until there's a rate to go on. */
export function timeLeft(remaining: number, progressed: number, seconds: number): string {
  if (progressed < 2 || seconds < 5 || remaining <= 0) return ''
  const left = (remaining * seconds) / progressed
  if (left < 45) return 'under a minute left'
  const minutes = Math.round(left / 60)
  return `about ${minutes} min left`
}
