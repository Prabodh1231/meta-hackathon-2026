// 24px line icons for the side rails and header. Stroke uses currentColor so they follow the theme.
// The sidebar's icons (the places and the Library's smart views, marked "Lucide") are adapted from
// Lucide, lucide.dev: ISC License, Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022
// as part of Feather (MIT); all other copyright (c) for Lucide are held by Lucide Contributors 2022.
// Circles and lines are written as paths, so each icon stays one path.
const C10 = 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0' // a circle of radius 10 in the middle
const BOX = 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' // a rounded square
const PATHS = {
  // Lucide: pencil
  write: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4',
  focus: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  // Lucide: table
  matrix: `${BOX}M12 3v18M3 9h18M3 15h18`,
  collapse: 'M8 6l6 6-6 6M19 5v14', // close a panel on the right: chevron toward its edge
  expand: 'M16 6l-6 6 6 6M5 5v14',
  // Lucide: folder (the Library opens on its topics drawn as folders)
  library: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  // Lucide: share-2 (papers joined by their citations)
  network: 'M15 5a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M15 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98',
  assistant: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  ask: 'M4 5h16v11h-9l-5 4v-4H4zM9.8 8.8a2.2 2.2 0 1 1 3 2c-.5.2-.8.6-.8 1.1M12 14h.01',
  cite: 'M7 8h4v4H8.5c0 1.4.9 2.5 2.5 2.9V17c-2.8-.4-4-2.4-4-5.2zm6 0h4v4h-2.5c0 1.4.9 2.5 2.5 2.9V17c-2.8-.4-4-2.4-4-5.2z',
  source: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 15h5M10 18h3',
  references: 'M5 6h14M5 10h14M5 14h10M5 18h8',
  review: 'M8 8h10v12H8zM5 15V4h10',
  history: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2',
  highlight: 'M9 15l-4 4h5l2-2M8.5 14.5l7-9a2 2 0 0 1 3 0l1 1a2 2 0 0 1 0 3l-9 7zM14 19h6',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 14H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9.7 3.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  plus: 'M12 5v14M5 12h14',
  drafts: 'M8 3h8l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM16 3v4h4M10 12h6M10 16h4M3 7v12a2 2 0 0 0 2 2',
  word: 'M6 3h9l4 4v14H6zM15 3v4h4M8.5 11l1.5 6 2-4.5 2 4.5 1.5-6',
  // Lucide: house
  home: 'M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  open: 'M7 17L17 7M9 7h8v8', // the corner arrow on a card: it opens that place
  back: 'M19 12H5M11 6l-6 6 6 6',
  forward: 'M5 12h14M13 6l6 6-6 6',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  check: 'M5 12l5 5 9-10',
  // The Library's smart views, and the sidebar's own button (all Lucide)
  layers: 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM22 17.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65M22 12.65l-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65', // layers
  clock: `${C10}M12 6v6l4 2`, // clock
  drafting: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z', // square-pen
  quote: 'M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2zM5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z', // quote
  alert: `${C10}M12 8v4M12 16h.01`, // circle-alert
  unread: `${C10}M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0`, // circle-dot
  star: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z', // star
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z', // inbox
  fileX: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M14.5 12.5l-5 5M9.5 12.5l5 5', // file-x
  archive: 'M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4', // archive
  trash: 'M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6M14 11v6', // trash-2
  funnel: 'M22 3H2l8 9.46V19l4 2v-8.54z', // funnel: a saved search and its filters
  sidebarClose: `${BOX}M9 3v18M16 15l-3-3 3-3`, // panel-left-close
  sidebarOpen: `${BOX}M9 3v18M14 9l3 3-3 3`, // panel-left-open
  close: 'M6 6l12 12M18 6 6 18',
  idea: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z', // lightbulb
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
