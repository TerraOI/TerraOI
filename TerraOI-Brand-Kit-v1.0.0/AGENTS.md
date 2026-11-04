# Instructions for agents maintaining this identity kit

Read `05-guides/AI-AGENT-GUIDE.md`, `05-guides/BRAND-GUIDE.md`, and `05-guides/WHITE-LABEL.md` before making changes.

Use `02-system/brand-config.json` for customer identity and `02-system/tokens.json` for visual tokens. Run `python3 tools/build.py` after editing either file. Do not hand edit `brand-config.js` or `token-vars.css`; they are generated outputs. Shared layouts are static HTML and shared behavior lives in `brand-ui.js`.

Preserve the user's selected presentation mode across navigation. Customer only mode must have no visible TerraOI identity in the product screens, page titles, favicon, reports, email, or document exports. Optional attribution is controlled exclusively by `showPoweredBy`.

The kit preview itself contains TerraOI artwork and guides by design. It is a design review tool, not a customer distribution portal. Deliver only the appropriate customer-facing files when shipping a customer product.

Do not imply a live agent performed an action. Keep human review and execution states explicit. Do not add an integration, publication, message send, or external deployment without authorization.

Run validation, inspect desktop and mobile previews, check all branding modes, update regenerated documents if affected, and record changes in CHANGELOG.md before repackaging. See AI-AGENT-GUIDE.md for the full acceptance checklist.
