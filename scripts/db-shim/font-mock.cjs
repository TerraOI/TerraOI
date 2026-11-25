// Offline build aid (TOI-005): this sandbox has no DNS for fonts.googleapis.com. Answers the one Inter
// request with a minimal @font-face whose file is /dev/null (Next reads absolute paths from disk when
// mocked). Only for `next build --webpack`; Turbopack fetches font files itself and cannot be mocked.
const css =
  "@font-face {\n  font-family: 'Inter';\n  font-style: normal;\n  font-weight: 100 900;\n  font-display: swap;\n" +
  "  src: url(/dev/null) format('woff2');\n  unicode-range: U+0000-00FF;\n}\n";
module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap": css,
};
