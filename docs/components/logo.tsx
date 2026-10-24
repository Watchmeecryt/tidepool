export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs><linearGradient id="tpg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2dd4bf" /><stop offset="1" stopColor="#0f766e" /></linearGradient></defs>
      <circle cx="16" cy="16" r="15" fill="url(#tpg)" />
      <path d="M5 17c3.5-3 7.5-3 11 0s7.5 3 11 0" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M8 22c2.7-2 5.3-2 8 0s5.3 2 8 0" fill="none" stroke="#fff" strokeOpacity=".7" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
