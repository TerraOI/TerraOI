# AI agent guide

## Purpose

Maintain and extend the TerraOI identity consistently across product screens, reports, email, and customer exports. Use this package as the source of design decisions. It is a design system and template library, not an operational agent runtime.

## Read before editing

1. Read root AGENTS.md and START-HERE.md.
2. Read BRAND-GUIDE.md and WHITE-LABEL.md.
3. Inspect `02-system/tokens.json`, `02-system/brand-config.json`, the current SVG masters, and the relevant HTML template.
4. Determine which presentation mode the user intends. Default to TerraOI for provider assets and customer for customer-only deliverables.

## Sources of truth

| Subject | Editable source | Generated or derived files |
| --- | --- | --- |
| Customer identity | brand-config.json | brand-config.js and generated documents |
| Design tokens | tokens.json | token-vars.css |
| Layout and responsive rules | brand.css | Browser screenshots |
| Screen structure | 03-templates/*.html | Printed PDFs and screenshots |
| Logo geometry | 01-identity/svg/*.svg | PNG, ICO, and small icons |
| Word template content | tools/generate_documents.py | DOCX and matching PDF |
| Product behavior examples | brand-ui.js | Preview interactions |

## Editing rules

Preserve the exact TerraOI name, descriptor, and tagline unless the user explicitly changes them. Keep the symbol's three-layer meaning, restrained brass, and connected-node motif. SVG wordmarks are path outlines; do not silently substitute a font. Full lockup descriptor text remains editable SVG text with a system font fallback.

Use shared tokens rather than introducing arbitrary colors or spacing. Customer-specific changes belong in configuration. Status colors remain semantic, with text labels. Never use brass alone to mean warning or approval. Use visible labels, keyboard focus, descriptive alt text, table headers, and responsive layouts.

In customer mode, replace every visible identity surface, not just the logo. Keep `showPoweredBy` false and remove attribution text from rendered customer-only output. Do not remove provider identity from root guides or historical references; those are maintenance materials.

Avoid inventing claims about deployed autonomy, performance, safety, accuracy, customers, certifications, or integrations. Sample records must remain clearly illustrative. Do not invent personal names, real customer contacts, operational telemetry, or numeric confidence scores.

Agent UI must distinguish observation, proposed plan, approval, execution, failure, and recorded outcome. The demo must never execute a real operational action. A real application needs its own authentication, permission enforcement, audit trail, and integration logic.

## Update workflow

1. Make the smallest coherent source changes that satisfy the request.
2. Run `python3 tools/build.py` to validate configuration and regenerate browser data and token CSS.
3. If SVG masters changed, regenerate PNG/ICO assets with a trusted SVG rasterizer. Preserve transparency; inspect at 16, 32, 64, and 256 px. Do not ship mismatched old PNGs.
4. If document content or identity changed, regenerate Word files using the optional document script, then export matching PDFs using Word or LibreOffice. Open every page after export.
5. Review desktop and mobile layouts in each mode. Confirm title, favicon, navigation, logo, owner, and attribution.
6. Review email source after variable substitution, including plain text. Do not send mail as part of maintenance unless explicitly requested.
7. Update CHANGELOG.md and version fields in config, tokens, START-HERE, and preview labels. Keep the package version in its folder name aligned.
8. Run `python3 tools/build.py --zip` and inspect the archive inventory. Keep outputs separate from working scripts and QA files.

## Acceptance checklist

- No broken links, missing local assets, script errors, clipped text, or horizontal page overflow at 390 px and 1440 px.
- All three presentation modes load; mode persists through navigation.
- TerraOI logo, customer logo, favicon, browser title, email sender label, report owner, and document prefix follow the selected mode.
- Powered attribution appears only in powered mode.
- Customer-only screens and customer Word/PDF have no visible provider branding or provider document metadata.
- Word and PDF exports agree with the source template and have readable page breaks.
- Logo PNGs match SVG masters and white/black versions are truly single color.
- Sample content remains labeled; approval preview sends no request and stores no credentials.
- ZIP contains the updated sources, guides, templates, and final assets, with no credentials, caches, machine-specific paths, or private telemetry.

## Reusable task prompt

“Read AGENTS.md and the guides in this identity kit. Update [specific asset] for [TerraOI / powered / customer] mode. Preserve the approved geometric logo, teal/brass palette where applicable, semantic status colors, and white-label rules. Update the editable sources, regenerate affected derivatives, inspect all affected screens and exports, update the changelog, and provide a versioned ZIP. Explain any remaining placeholders or limitations.”
