# brand/

TerraOI's visual identity and white-label system. Treat it as a **design source**, not application code.

| Item | Value |
|---|---|
| Contents | [terraoi-brand-kit/](terraoi-brand-kit/): TerraOI Brand Kit **v1.0.0** (version in `02-system/brand-config.json`, history in `CHANGELOG.md`) |
| Start here | [terraoi-brand-kit/START-HERE.md](terraoi-brand-kit/START-HERE.md) |
| Rules for editing the kit | [terraoi-brand-kit/AGENTS.md](terraoi-brand-kit/AGENTS.md). It applies inside the kit and adds to the root [AGENTS.md](../AGENTS.md). |
| White-label modes | [WHITE-LABEL.md](terraoi-brand-kit/05-guides/WHITE-LABEL.md): `terraoi`, `powered`, `customer` (plan §5.1) |
| Owner | Supervisor (protected path in `.github/CODEOWNERS`) |

## Layout of the kit

| Folder | What it holds | Used by the app? |
|---|---|---|
| `01-identity/` | Logos, symbols, favicons (SVG/PNG/ICO) | Yes: platform-owned surfaces and the `terraoi` mode |
| `02-system/` | `tokens.json`, `brand-config.json` (sources) and generated `token-vars.css`, `brand-config.js`, `brand.css`, `brand-ui.js` | Tokens and config: yes, via `src/platform/branding/` (T-103, T-204) |
| `03-templates/` | Static HTML reference screens and email templates | Reference only; rebuilt as React components, not imported |
| `04-documents/` | DOCX/PDF report and decision-record templates | Later: report exports (after M1) |
| `05-guides/` | Brand, white-label, agent and font guides | Reading for builders and agents |
| `06-reference/`, `examples/` | Concept references and a customer example | Reference only |
| `tools/` | `build.py` (regenerates `02-system` outputs), document generators | Run by whoever edits the kit |

## Rules

1. **The app never imports from this folder at runtime.** `src/platform/branding/` reads `tokens.json` and `brand-config.json` and validates them against the `TenantBrand` contract. Copying values by hand into components is not allowed.
2. **Edit sources, then regenerate.** Change `tokens.json` or `brand-config.json`, run `python3 brand/terraoi-brand-kit/tools/build.py`, and commit the sources together with the regenerated outputs. Never hand-edit `token-vars.css` or `brand-config.js`.
3. **Kit releases are versioned.** Bump the version in `brand-config.json`, add a `CHANGELOG.md` entry, and keep the folder name `terraoi-brand-kit/`, so imports and links never change between versions.
4. **Customer deliverables** take only the customer-facing files (kit AGENTS.md). This folder, with TerraOI artwork, is a design review source, not something to send to customers.
