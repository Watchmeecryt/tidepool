/** Tidepool mark in the NEAR Private OTC warm palette (gold disc, ink waves). */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="#ffc052" />
      <path d="M5 17c3.5-3 7.5-3 11 0s7.5 3 11 0" fill="none" stroke="#1d1b18" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M8 22c2.7-2 5.3-2 8 0s5.3 2 8 0" fill="none" stroke="#1d1b18" strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
