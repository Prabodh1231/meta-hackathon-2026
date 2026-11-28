/** On Windows and Linux the main window has no title bar of its own (main.cjs): the app bar stands in for
 * it, moving the window and holding its buttons (WindowButtons.tsx). Marks the page (html.frameless) so
 * the CSS makes the bar the window's handle. Not the reader's window, which keeps its usual frame. */
export function markFrameless() {
  document.documentElement.classList.toggle('frameless', !!window.rc?.windowControls)
}
