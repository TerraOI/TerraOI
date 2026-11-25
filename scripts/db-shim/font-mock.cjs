// Offline build aid (TOI-005): this sandbox has no DNS for fonts.googleapis.com. Answers the one Inter
// request with a minimal @font-face pointing at a throwaway local file. Only for `next build --webpack`;
// Turbopack fetches font files itself and cannot be mocked this way.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const file = path.join(os.tmpdir(), "terraoi-mock-inter.woff2");
if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.alloc(1024));
const css = "@font-face {\n  font-family: 'Inter';\n  font-style: normal;\n  font-weight: 100 900;\n  font-display: swap;\n  src: url(" + file + ") format('woff2');\n  unicode-range: U+0000-00FF;\n}\n";
module.exports = {
  "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap": css,
};
