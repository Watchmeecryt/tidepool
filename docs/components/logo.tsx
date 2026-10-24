import { useId } from 'react';

export function Logo({ size = 24 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ filter: 'drop-shadow(0 0 6px rgb(45 212 191 / .55))' }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2dd4bf" /><stop offset="1" stopColor="#0f766e" /></linearGradient></defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${id})`} />
      <path d="M5 17c3.5-3 7.5-3 11 0s7.5 3 11 0" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M8 22c2.7-2 5.3-2 8 0s5.3 2 8 0" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
