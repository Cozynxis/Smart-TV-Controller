# Smart TV Controller

A responsive Smart TV remote web app with a local LAN bridge for discovery and TV control.

## What is included

- Responsive desktop/mobile dashboard
- Installable PWA shell and offline cache
- SSDP network discovery through the local bridge
- Saved TVs and manual IP entry
- Full remote layout with D-pad, volume, channels and media keys
- App listing/launching when the TV exposes it
- Philips Ambilight modes when exposed by JointSpace
- Philips JointSpace support, including digest-auth credentials
- Local-only credential storage (`bridge/devices.local.json`, ignored by Git)

## Why there is a bridge

A GitHub Pages page is static and browsers restrict direct LAN discovery and mixed-content/local-network requests. The included bridge performs SSDP discovery and talks to TVs locally.

For actual TV control, the recommended URL is the copy served by the bridge itself: `http://localhost:8765`. GitHub Pages can still host/show the frontend.

## Quick start

Install Node.js 18+ on a computer that is on the same network as the TV, clone/download this repository, then run:

```bash
cd bridge
npm install
npm start
```

Open:

```text
http://localhost:8765
```

The bridge listens on port `8765` by default.

## Philips Android TV / JointSpace v6

Modern Philips Android TVs typically require one-time JointSpace pairing credentials before control requests are accepted. After obtaining those credentials from the TV pairing flow, open:

```text
http://localhost:8765/pair.html
```

Enter the TV IP, JointSpace username and password. Credentials are stored only in `bridge/devices.local.json` on that computer and the file is excluded by `.gitignore`.

Older Philips models with an unsecured JointSpace endpoint on port `1925` are attempted automatically.

## Current adapter status

Philips JointSpace is the first working vendor adapter. Samsung, LG and generic Android/Google TV choices are present in the UI as expansion targets, but the bridge intentionally returns an unsupported-adapter message instead of pretending commands succeeded.

Some capabilities vary by model/firmware. In particular, arbitrary per-zone static RGB Ambilight writing is not exposed consistently by Philips JointSpace; supported follow-video/follow-audio/off modes are attempted instead.
