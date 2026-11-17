# danielthompson.digital

Personal portfolio and consulting site for **Daniel Thompson**, a digital strategist and ecommerce growth consultant based in Floreal, Mauritius.

Live at **[danielthompson.digital](https://danielthompson.digital/)**.

## Overview

A single-page, static site built as a **bento grid**: tiles for the intro, headshot, current role (TheBrandHouse), key stats, services, experience, a selected-work gallery, and a contact form. There is no build step, framework, or backend. Everything is hand-written HTML, CSS, and vanilla JavaScript in `index.html`.

## Tech stack

- **Plain HTML / CSS / JS**: no framework, no bundler, no dependencies to install.
- **Google Fonts**: [Inter](https://fonts.google.com/specimen/Inter) (body) and [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) (labels and accents).
- **Formspree**: handles contact-form submissions ([`formspree.io/f/xlgwrkel`](https://formspree.io/f/xlgwrkel)), submitted via `fetch` with an inline success or error state.
- **Google Analytics 4**: tag `G-NJDC5HFNE1`; fires a `generate_lead` event on successful form submission.

## Project structure

```
.
├── index.html                 # The entire site: markup, styles, and scripts
├── images/
│   ├── dt-logo.svg            # "dt_" cursor logo (dark backgrounds, animated cursor)
│   ├── dt-logo-light.svg      # Logo for light backgrounds
│   ├── og-image.svg           # Source for the social share image
│   ├── daniel-thompson-og-image.jpg   # Social share (OG/Twitter) image, rendered from og-image.svg
│   ├── dt-headshot.png / dt-headshot2.png
│   ├── tbh-dtdl.png / global-marketplace.jpeg / kgn-dtdl.jpg   # Experience logos
│   └── favicon_io/            # Favicons (incl. dt-icon.svg) + site.webmanifest
├── work/
│   └── lcs-ceo-dashboard.html # Interactive CEO dashboard concept for Le Coffee Shop (sample data)
├── tools/
│   └── build-og-image.py      # Regenerates og-image.svg and the OG .jpg
├── icon.af                    # Affinity Designer source for the old badge logo
└── README.md
```

## How it works

The interactive pieces live in the inline `<script>` at the bottom of `index.html`:

- **Experience tile**: native `<details>` accordions; opening one closes the others so the tile stays compact.
- **Recent work gallery**: `.work` cards with screenshots in `images/work/`. The first card (`.work-feature`) spans both columns. To add a project, copy a card and swap the `background-image`, `href`, title and tag.
- **Contact form**: submits to Formspree via `fetch`; on success it swaps in a thank-you message and reports a GA4 `generate_lead` event; on failure it shows an error that points to the email address.
- **Cursor spotlight + reveal**: tiles glow softly under the cursor and fade in on scroll. Tiles only start hidden when JS is running (`html.js`), and all motion is turned off for `prefers-reduced-motion`.

## Local development

No tooling required. Either open the file directly:

```bash
open index.html
```

Or serve it over HTTP (recommended, so relative paths and fonts behave exactly as in production):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

Edit `index.html` and refresh — that's the whole loop.

## Deployment

Hosted on **Cloudflare Pages**, deployed from the `main` branch of this repo ([`dathnoth/danielthompson-digital`](https://github.com/dathnoth/danielthompson-digital)). Pushing to `main` publishes the site.

## Updating the social share image

Edit the layout in `tools/build-og-image.py`, then run it (macOS, uses `sips`):

```bash
python3 tools/build-og-image.py
```

It writes `images/og-image.svg` and renders `images/daniel-thompson-og-image.jpg` (1200×630), which the Open Graph and Twitter Card tags in `index.html` reference.
