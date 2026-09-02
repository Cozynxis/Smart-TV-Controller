# Smart TV Controller

A responsive Smart TV remote web app with a local bridge for LAN discovery and TV control.

## Architecture

- `index.html`, `css/`, `js/`: static PWA frontend, suitable for GitHub Pages.
- `bridge/`: local Node.js service for SSDP discovery and vendor-specific TV APIs.

## Quick start

1. Enable GitHub Pages for the `main` branch.
2. On a computer on the same network as the TV, install Node.js 18+.
3. Run:

```bash
cd bridge
npm install
npm start
```

4. Open the web app and connect it to the bridge URL shown in the terminal (default `http://localhost:8765`).

> TV features vary by brand/model. Philips/JointSpace support is the first vendor implementation; other adapters are included as safe placeholders for expansion.
