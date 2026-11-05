# White labeling

## Modes

| Mode | Visible identity | Attribution |
| --- | --- | --- |
| terraoi | TerraOI logo, teal primary, brass accent | Hidden |
| powered | Customer logo, customer colors | Powered by TerraOI |
| customer | Customer logo, customer colors | Hidden |

The browser preview uses `?brand=terraoi`, `?brand=powered`, or `?brand=customer`. The selector is a design review control. Do not expose cross-customer identity switching in a production tenant UI.

## Configure a customer

Edit the `powered` and `customer` entries in `02-system/brand-config.json`. Supply name, descriptor, tagline, logo path, favicon path, primary color, on-primary text color, accent color, report owner, email sender name, document prefix, support label, and optional reply-to address. Reply-to is blank until a real customer address is approved; it is never inferred. Asset paths are relative to the package root.

Set `defaultMode` to the intended default and run `python3 tools/build.py`. Customer mode requires `showPoweredBy: false`. Powered mode requires it to be true. Replace all Customer Brand placeholders before delivery.

The HTML templates apply name, logo, favicon, browser title, customer accent colors, owner labels, sender labels, and attribution at runtime. They do not read JSON directly, which keeps the preview usable from a local folder.

## Email and exports

`notification-email.html` is a table-based source template for your email system. Populate every `{{variable}}`, use an absolute HTTPS URL for the customer logo and report action, and set `{{attribution_html}}` to either an empty string or the approved Powered by TerraOI footer. The plain-text version uses the same rule for `{{attribution_text}}`. HTML-escape text values and validate links before insertion. Never send an unresolved template.

Generate customer Word/PDF outputs with `tools/generate_documents.py --mode customer`. Attribution in those templates follows the configuration. The bundled customer examples have no TerraOI identity visible. File metadata is also set to Customer Brand. For a real deployment, inspect output filenames, document properties, PDF metadata, sender address, reply-to, hosted logo URLs, notifications, login metadata, browser title, support links, social previews, and scheduled exports.

## Scope of full customer branding

“Fully customer-branded” describes customer-facing presentation. This distributable developer kit and its source files retain TerraOI names for maintenance. If the customer must not receive provider source names or assets, distribute a customer-only build from your application rather than the complete identity kit. The preview's index page intentionally shows TerraOI masters and the historical concept board.

## Acceptance check

Open every screen in all three modes. Confirm the mode persists through links. Verify that the customer favicon and browser title change, and that Powered by TerraOI appears only in powered mode. Check the email preview and separately populate the sendable email source. Inspect each generated Word/PDF after regeneration. Search visible customer output and metadata for unintended TerraOI references. Review narrow screens and printed pages for clipping.
