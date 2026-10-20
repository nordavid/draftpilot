// Small controls: switch, segmented control, stepper.

export function Switch(props: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      className="switch"
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switch-thumb" />
    </button>
  )
}

export function Segmented<T extends string>(props: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          type="button"
          role="radio"
          key={o.value}
          aria-checked={props.value === o.value}
          disabled={props.disabled}
          className={props.value === o.value ? 'is-on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Stepper(props: {
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  label: string
  lessLabel: string
  moreLabel: string
  disabled?: boolean
}): React.JSX.Element {
  const { value, min, max, step } = props
  return (
    <div className="stepper" aria-label={props.label} role="group">
      <button
        type="button"
        aria-label={props.lessLabel}
        disabled={props.disabled || value <= min}
        onClick={() => props.onChange(Math.max(min, value - step))}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <output>{props.format(value)}</output>
      <button
        type="button"
        aria-label={props.moreLabel}
        disabled={props.disabled || value >= max}
        onClick={() => props.onChange(Math.min(max, value + step))}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M5 2v6M2 5h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
