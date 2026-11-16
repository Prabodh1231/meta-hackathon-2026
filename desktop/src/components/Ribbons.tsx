import { useId } from 'react'

/** The app's artwork: three overlapping ribbons, peach into ember into ice into slate. Colours come
 * from the palette (styles.css), so the one drawing follows light and dark. `tall` bleeds off the
 * right edge of a headline area or banner; `wide` sits along the bottom of a panel. */
export function Ribbons({ shape = 'tall', className = '' }: { shape?: 'tall' | 'wide'; className?: string }) {
  // Gradient ids must be unique on the page: the drawing appears several times at once.
  const id = `rb${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const defs = (
    <defs>
      <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style={{ stopColor: 'var(--peach)' }} />
        <stop offset=".55" style={{ stopColor: 'var(--ember)' }} />
        <stop offset="1" style={{ stopColor: 'var(--ice)' }} />
      </linearGradient>
      <linearGradient id={`${id}b`} x1="1" y1="0" x2="0" y2="1">
        <stop offset="0" style={{ stopColor: 'var(--ember)' }} />
        <stop offset=".6" style={{ stopColor: 'var(--ice)' }} />
        <stop offset="1" style={{ stopColor: 'var(--ban2)' }} />
      </linearGradient>
      <linearGradient id={`${id}c`} x1=".2" y1="0" x2=".8" y2="1">
        <stop offset="0" style={{ stopColor: 'var(--ice)' }} />
        <stop offset="1" style={{ stopColor: 'var(--ban2)' }} />
      </linearGradient>
    </defs>
  )
  if (shape === 'wide')
    return (
      <svg className={`ribbons ${className}`} viewBox="0 0 600 240" preserveAspectRatio="none" aria-hidden="true">
        {defs}
        <path fill={`url(#${id}a)`} d="M-10 250C80 120 190 210 300 120 400 40 470 110 610 10V250Z" />
        <path fill={`url(#${id}b)`} opacity=".9" d="M-10 250C120 170 230 240 350 160 450 96 520 150 610 90V250Z" />
        <path fill={`url(#${id}c)`} opacity=".88" d="M-10 250C160 214 280 250 400 204 490 170 550 200 610 170V250Z" />
      </svg>
    )
  return (
    <svg className={`ribbons ${className}`} viewBox="0 0 600 600" preserveAspectRatio="none" aria-hidden="true">
      {defs}
      <path fill={`url(#${id}a)`} d="M620-20C400 40 520 250 330 350 210 414 262 556 170 640h450Z" />
      <path fill={`url(#${id}b)`} opacity=".9" d="M620 30C486 128 566 300 420 396 322 462 384 578 312 640h308Z" />
      <path fill={`url(#${id}c)`} opacity=".88" d="M620 170C552 250 604 380 516 458 462 506 500 598 464 640h156Z" />
      <path
        fill="none"
        stroke="#fff"
        strokeOpacity=".35"
        strokeWidth="1.5"
        d="M620 30C486 128 566 300 420 396 322 462 384 578 312 640M620 170C552 250 604 380 516 458 462 506 500 598 464 640"
      />
    </svg>
  )
}
