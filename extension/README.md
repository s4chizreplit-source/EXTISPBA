# OrganicSMM Pro — Chrome Extension

Production-ready Manifest V3 Chrome Extension for the OrganicSMM Pro platform.
The extension reuses the entire existing web app (auth, database, edge
functions, UI, business logic) by loading `https://organicsmm.pro` inside the
popup and side panel — no duplicate frontend, no mock data.

## Install (Developer Mode)

1. Download `organicsmm-pro-extension.zip` from the app (or use the `extension/` folder directly).
2. Unzip if needed.
3. Open `chrome://extensions` in Chrome / Edge / Brave / Arc / Opera.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the `extension/` folder.
6. Pin **OrganicSMM Pro** to the toolbar. Click the icon (or press `Alt+O`) to open the popup.

## Features

- **Popup app** – full OrganicSMM Pro dashboard, orders, services, wallet, admin, chat.
- **Side panel** – keep the app open next to any browsing tab.
- **Open in tab** – one-click launch of the full site.
- **Session persistence** – authentication is handled by the live app; sessions stay signed in via Supabase's own storage.
- **Notifications & badge** – background service worker ready for order/balance alerts.
- **Keyboard shortcut** – `Alt+O` opens the popup.

## Files

- `manifest.json` – MV3 manifest.
- `popup.html` / `popup.js` – toolbar popup shell.
- `sidepanel.html` – side-panel shell.
- `background.js` – service worker (badge, notifications, side-panel behavior).
- `icons/` – 16/32/48/128 icons.

## Build a distributable ZIP

From the project root:

```bash
rm -f public/organicsmm-pro-extension.zip
cd extension && nix run nixpkgs#zip -- -r ../public/organicsmm-pro-extension.zip .
```

The ZIP is then served from `/organicsmm-pro-extension.zip` on the live site.
