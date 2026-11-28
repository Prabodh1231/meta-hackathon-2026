// Node runs the app's TypeScript as it is, but the app's own imports leave out ".ts" (Vite fills it
// in): fill it in here too, so a test can import any module that has no JSX. `npm test` loads this.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (e) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw e
    }
  },
})
