import { SymbolPaths } from "./logo-symbol";

// The kit's terraoi-logo-color.svg (symbol, rule and wordmark) as JSX, geometry unchanged.
export function LogoWordmark({ height = 28 }: { height?: number }) {
  return (
    <svg viewBox="0 0 640 140" height={height} width={(height * 640) / 140} role="img" aria-label="TerraOI">
      <SymbolPaths />
      <path d="M157 13V125" stroke="#17252B" strokeWidth="1.5" />
      <g transform="translate(182 28) scale(1.07)" fill="#17252B" fillRule="evenodd">
        <path d="M0 0H60V13H38V76H22V13H0Z" />
        <path d="M0 25L10 15H47L57 25V49H16V61H55V76H10L0 66ZM16 29V37H41V29Z" transform="translate(68 0)" />
        <path d="M0 27L12 15H45L35 30H16V76H0Z" transform="translate(133 0)" />
        <path d="M0 27L12 15H45L35 30H16V76H0Z" transform="translate(186 0)" />
        <path d="M2 15H45L56 26V76H12L0 64V47L12 36H40V30H2ZM16 50V62H40V50Z" transform="translate(239 0)" />
        <path d="M12 0H49L61 12V64L49 76H12L0 64V12ZM17 15V61H44V15Z" transform="translate(303 0)" />
        <path d="M0 0H17V76H0Z" transform="translate(372 0)" />
      </g>
    </svg>
  );
}
