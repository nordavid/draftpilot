import type { Role } from '@shared/index'

// Schlichte Lane-Icons: Kartenquadrat (blass) + hervorgehobene Lane.

export function RoleIcon(props: { role: Role; size?: number }): React.JSX.Element {
  const s = props.size ?? 20
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {props.role === 'top' && (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" opacity="0.3" strokeWidth="1.4" />
          <path d="M3.8 16.2V3.8h12.4" strokeWidth="2.4" />
        </>
      )}
      {props.role === 'middle' && (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" opacity="0.3" strokeWidth="1.4" />
          <path d="M5 15 15 5" strokeWidth="2.4" />
        </>
      )}
      {props.role === 'bottom' && (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" opacity="0.3" strokeWidth="1.4" />
          <path d="M3.8 16.2h12.4V3.8" strokeWidth="2.4" />
        </>
      )}
      {props.role === 'jungle' && (
        <path
          d="M10 2.8c-3.6 3.3-4.6 7.6-2.4 11.4M10 2.8c3.6 3.3 4.6 7.6 2.4 11.4M10 6.5v10.7"
          strokeWidth="1.9"
        />
      )}
      {props.role === 'utility' && (
        <path d="M10 3.2 15.8 5.4v4.2c0 3.6-2.5 6-5.8 7.2-3.3-1.2-5.8-3.6-5.8-7.2V5.4Z" strokeWidth="1.9" />
      )}
      {props.role === 'none' && (
        <>
          <circle cx="10" cy="10" r="6.6" strokeWidth="1.6" strokeDasharray="2.6 2.4" />
          <circle cx="10" cy="10" r="1.6" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}
