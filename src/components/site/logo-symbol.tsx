// The kit's terraoi-symbol-color.svg as JSX, geometry unchanged. Nothing is read from brand/ at runtime.
export function SymbolPaths() {
  return (
    <>
      <path d="M22 39L57 13H108L128 24L95 48H22Z" fill="none" stroke="#007F78" strokeWidth="6" strokeLinejoin="miter" />
      <path d="M22 77L57 51H108L128 62L95 86H22Z" fill="none" stroke="#A48748" strokeWidth="6" strokeLinejoin="miter" />
      <path d="M22 115L57 89H108L128 100L95 124H22Z" fill="none" stroke="#17252B" strokeWidth="6" strokeLinejoin="miter" />
      <path d="M108 15V34H83V69H67V110" fill="none" stroke="white" strokeWidth="8" />
      <path d="M108 15V34H83V69H67V110" fill="none" stroke="#17252B" strokeWidth="3" />
      <circle cx="108" cy="15" r="7" fill="#007F78" stroke="white" strokeWidth="2" />
      <circle cx="83" cy="69" r="7" fill="#A48748" stroke="white" strokeWidth="2" />
      <circle cx="67" cy="110" r="7" fill="#17252B" stroke="white" strokeWidth="2" />
    </>
  );
}

export function LogoSymbol({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 150 140" width={size} height={(size * 140) / 150} role="img" aria-label="TerraOI">
      <SymbolPaths />
    </svg>
  );
}
