const PATHS: Record<string, JSX.Element> = {
  back: <path d="M15 5l-7 7 7 7" />,
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </g>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.8-3.8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  clipboard: (
    <>
      <rect x="6" y="5" width="12" height="16" rx="2.5" />
      <path d="M9 5a3 3 0 0 1 6 0" />
      <path d="M9.5 12h5M9.5 16h3" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M3.5 12h17" />
    </>
  ),
  home: (
    <>
      <path d="M4 11l8-7 8 7" />
      <path d="M6.5 9.8V19a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9.8" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
    </>
  ),
  chev: <path d="M9 6l6 6-6 6" />,
  box: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 19c1-3 3.5-4.5 6-4.5s5 1.5 6 4.5" />
      <path d="M16 5a3.5 3.5 0 0 1 0 7M21 19c-.7-2.3-2-3.8-4-4.4" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H5v16h4" />
      <path d="M14 8l4 4-4 4M18 12H9" />
    </>
  ),
  check: <path d="M5 12.5l5 5L20 7" />,
  cal: (
    <>
      <rect x="4" y="6" width="16" height="15" rx="2.5" />
      <path d="M4 10.5h16M8.5 4v4M15.5 4v4" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3.5L22 20H2z" />
      <path d="M12 10v4.5M12 17.5h.01" />
    </>
  ),
  backspace: (
    <>
      <path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z" />
      <path d="M12 9.5l6 5M18 9.5l-6 5" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h13l-2.5 4L18 12H5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  cube: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
}

export default function MIcon({ name, size = 22, className }: { name: string; size?: number; className?: string }) {
  const path = PATHS[name] || PATHS.box
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {path}
    </svg>
  )
}
