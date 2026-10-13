# Presentation package

## Read-only demo recording script

[Demo script and reading mode](aveo-demo-script.en.html): six steps, Portuguese
navigation instructions and English narration. Select the incident variant that
matches the visible result. This recording does not demonstrate signed recovery.
Preview: `http://localhost:8767/aveo-demo-script.en.html`; arrows navigate,
T toggles reading mode and Esc exits it. Keep this script outside the captured area.

## Juror-focused pitch — v0.4

- [Slides](aveo-pitch-v0.4.en.html), [six-page PDF](aveo-pitch-v0.4.en.pdf), [spoken script](aveo-pitch-v0.4.en.txt).
- [Objection responses and remaining human/technical actions](judge-objections-v0.4.en.md).
- Explicit Solana rationale, honest competitor/manual-workflow comparison, buyer
  and budget-owner hypotheses, current demo boundaries and technical accountability.
- Preserves v0.3; no user evidence, price validation, registration or wallet acceptance
  is fabricated. Preview URL ends in `aveo-pitch-v0.4.en.html`; N/T/arrow controls are unchanged.

## Revised pitch — v0.3

- [Warmer English slides](aveo-pitch-v0.3.en.html), [PDF](aveo-pitch-v0.3.en.pdf), and [spoken script](aveo-pitch-v0.3.en.txt).
- [Impact-focused demo plan and rehearsal instructions](demo-recording-v0.3.en.md).
- v0.3 adds the founder opening, a clearly hypothetical scale scenario, sourced
  market context and a direct invitation to inspect the product. It does not close
  wallet/security/public-demo gates. v0.2 remains preserved below.
- Use the same N/T/arrow controls. Preview URL ends in `aveo-pitch-v0.3.en.html`.

## Current English pitch — v0.2

- [Interactive slides and reading mode](aveo-pitch-v0.2.en.html)
- [Six-slide 16:9 PDF](aveo-pitch-v0.2.en.pdf)
- [Separate spoken script](aveo-pitch-v0.2.en.txt)
- [Render receipt and source/PDF hashes](aveo-pitch-v0.2.en.receipt.json)
- Six PNG slide images: `aveo-pitch-v0.2.en.slide-1.png` through `slide-6.png`.

Download/open the PDF directly for presenting. The HTML is self-contained and
works offline in a regular browser; it requires no application server or RPC.
In VS Code, locate `docs/presentation/`, then download the PDF/HTML when using SSH.

For a local browser preview from a remote VPS:

```bash
python3 -m http.server 8767 --bind 127.0.0.1 --directory docs/presentation
```

Forward port 8767 in VS Code, then open
`http://localhost:8767/aveo-pitch-v0.2.en.html`. If the port is already occupied,
use the existing preview or select another unused port; do not stop an unrelated service.

## Present, rehearse and record

- Left/right arrows or Previous/Next move between slides.
- `N` toggles speaker notes; `T` toggles the larger reading mode; Escape leaves it.
- Reading mode is manually paced: it does not promise a three-minute duration.
- Notes are excluded from PDF/print output. Hide notes and controls from the
  recording area, or record the PDF full-screen while reading the script separately.
- Read slide 5 as Bruno only if he is the speaker; another teammate must adjust
  the first-person father/son wording. Individual student roles remain unassigned.
- The slides use Aveo's light palette, typography and card language, not a copied
  application interface. No customer, audit, pricing or protocol-integration claims
  are invented. The business slide deliberately avoids unsupported market figures.
- Slide 6 preserves pending wallet/security acceptance. Update it only after retained
  evidence closes the gates; this is a pitch package, not the technical demo video.

## Regenerate safely

Keep the v0.1 Portuguese narrative as historical material. Do not overwrite an
already distributed snapshot: create a new version, update filenames and tests,
and render using the previously approved isolated Playwright installation:

```bash
node scripts/render-pitch.mjs /absolute/path/to/playwright/index.mjs \
  docs/presentation/aveo-pitch-v0.2.en.html
```

The renderer refuses existing output paths. It runs without network requests,
checks six pages and layout, and exercises keyboard/reading/mobile controls.
Run `node --test scripts/render-pitch.test.mjs scripts/render-presentation.test.mjs`
and `pnpm verify` before publishing. Browser/PDF generation adds no repository dependency.
Source revision in the receipt is the stated working-tree base, not a claim that
uncommitted editorial files already existed in that commit.

An initial render failed the mobile assertion because the viewport resize handler
had not settled. Waiting for the resized stage fixed the harness; the earlier
generated artifacts were moved to a private temporary directory, not deleted.
Inspect rendered slides visually as well as running the automated checks.
