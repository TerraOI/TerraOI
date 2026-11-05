# Updating and sharing the kit

## Everyday edits

The HTML, SVG, JSON, CSS, Markdown, plain-text email, and Python tools are editable sources. Keep the original ZIP as a versioned baseline. Edit a copy of the extracted folder and record changes in CHANGELOG.md.

Run `python3 tools/build.py` after configuration or token changes. The builder uses only Python's standard library. It validates required fields, hexadecimal colors, local logo paths, attribution modes, and primary-button contrast, then refreshes browser configuration and token variables.

## Documents

Editable Word templates and corresponding PDFs are supplied for TerraOI and Customer Brand. Edit text directly in Word for one-off work. For repeatable generation, install the optional dependencies from `tools/requirements-documents.txt`, then run:

```
python3 tools/generate_documents.py --mode terraoi
python3 tools/generate_documents.py --mode customer
```

You can also generate powered mode with `--mode powered`. The generator reads brand-config.json and uses the matching PNG logo. For a new customer, create a PNG version of their SVG at the configured logo path with the `.png` extension. The sample customer PNG is provided. Set the actual name, owner, and prefix before generating real customer documents.

Word generation does not automatically update PDFs. Open the DOCX in Word or LibreOffice and export PDF, replacing the matching PDF file. Inspect all pages after export, including logos, table wrapping, headers, footers, placeholders, and document properties. HTML report and decision-record templates also include a Print / save as PDF action that uses the current browser branding mode.

## Logo edits

Edit SVG masters in a vector editor. Re-export matching transparent PNGs and favicon sizes. Supplied PNGs are 4x vector dimensions, with 16, 32, 48, 64, 180, 192, 256, and 512 px icons. The favicon is simplified intentionally. Keep true single-color artwork for monochrome use.

## Email edits

Use the HTML preview to review appearance. The sendable email source is a separate table-based template with inline styling and a plain-text companion. Replace every variable, use absolute hosted asset URLs, and test in your email platform before sending. The kit does not configure a sender domain or deliver messages.

## Package a new release

Update version fields and preview labels. Rename the folder with the new version. Run `python3 tools/build.py --zip`. This creates an archive beside the kit folder and includes the editable sources. Do not include private customer settings, credentials, or internal data in a publicly shared kit.

The original validation summary is in QUALITY.md. Re-run those checks after meaningful updates; the original summary does not certify later changes.
