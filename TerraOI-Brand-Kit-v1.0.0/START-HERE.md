# TerraOI Identity Kit

Version 1.0.0 · 3 November 2026

Unzip the complete folder, then open **index.html** in a modern browser. No installation or internet connection is needed. Use the Presentation selector to review TerraOI, Customer + Powered by TerraOI, and Customer only.

This package includes editable identity artwork and presentation templates. Screens demonstrate design and interactions; they do not provide authentication, live telemetry, agent execution, or email delivery. All sample activity is illustrative.

## Where to find things

| Folder | Contents |
| --- | --- |
| 01-identity | SVG logo masters, transparent PNGs, favicon SVG, PNG sizes, and ICO |
| 02-system | Shared styling, tokens, editable brand settings, and configuration schema |
| 03-templates | Login, navigation, dashboard, agent workspace, report, decision record, and email |
| 04-documents | Editable Word templates and matching PDFs for TerraOI and Customer Brand |
| 05-guides | Brand rules, white-label instructions, AI agent guide, and maintenance guidance |
| 06-reference | Previous concept board and preview images |
| examples/customer | Replaceable customer logo and icon |
| tools | Standard Python configuration builder and optional Word template generator |

## Make an update

1. Copy the kit and edit `02-system/brand-config.json`. Replace the sample customer logo and favicon with approved artwork. Do not put secret credentials in this file.
2. Run `python3 tools/build.py` from the kit folder. This validates settings and regenerates the browser configuration and CSS token foundation.
3. Open the preview again and review all three modes. The selector keeps the selected mode when you follow internal screen links.
4. To update Word/PDF outputs, see `05-guides/UPDATING.md`. HTML reports can also be printed to PDF directly from the preview.
5. Update the version and changelog, then run `python3 tools/build.py --zip` to create a new distributable archive beside the folder.

For an AI agent, start with **AGENTS.md** and **05-guides/AI-AGENT-GUIDE.md**. For a designer, start with **05-guides/BRAND-GUIDE.md**. For white labeling, read **05-guides/WHITE-LABEL.md**.

Customer mode changes logo, favicon, page title, visible identity, document owner, sender name, and attribution. A complete deployed implementation must apply the same configuration to its own email sender settings, downloadable exports, metadata, asset delivery, and connected services. The bundled customer Word/PDF examples use Customer only mode.
