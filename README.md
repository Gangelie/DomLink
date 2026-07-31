# DomLink

**A self-hosted, local bridge between [Domoticz](https://www.domoticz.com/) and Amazon Alexa — no Node-RED, no cloud account, no third-party service required.**

🇬🇧 English (this file) · [🇩🇪 Deutsch](README.de.md)

---

## What is DomLink?

DomLink is a small Node.js/Express application, shipped as a single Docker container, that:

- reads all your active devices from Domoticz,
- lets you pick which ones Alexa should see, and how (switch, light, dimmer, blind, thermostat, temperature sensor),
- exposes them to Alexa by running its own **local [Matter](https://csa-iot.org/all-solutions/matter/) bridge** — commissioned directly from the Alexa app, entirely on your own network, and
- gives you a dark-mode web dashboard to manage all of it, protected by a login, including a live protocol view for debugging.

## Features

- 🔒 **Auth** — password-protected UI & API (session-based), default password `admin`, forced change on first login
- ⚙️ **Everything configurable from the UI** — Domoticz connection, device selection, password — persisted to `data/config.json`, with automatic rolling backups before every save
- 🔌 **Bidirectional Domoticz integration** — On/Off, dimming, blinds and thermostat setpoints from Alexa; live sensor reads reported back to Alexa
- 🗣️ **Native local Matter bridge** — no cloud account, no device-count limits, no Node-RED. Pair once via QR code or manual code directly in the Alexa app
- 📋 **Live protocol view** — watch commands from Alexa and the resulting Domoticz calls (and vice versa) in real time, right in the dashboard — invaluable for debugging device mix-ups
- 🌓 **Dark-mode dashboard** with tabs: All devices, Lights & Dimmers, Switches & Plugs, Blinds, Sensors & Thermostats, Meters, Settings
- 🔢 **Automatic device classification** from Domoticz metadata (switch / light / dimmer / blind / temperature sensor / thermostat / meter), fully overridable per device — read-only meters/counters (kWh, voltage, gas, ...) are shown for reference but never exposed to Alexa by default
- 🐳 **Single container** — one Docker image, one bind-mounted data directory

## How the Alexa pairing works (there is no cloud account involved)

Matter devices are commissioned directly, on your local network — no Amazon developer account, no third-party cloud service:

1. Start DomLink; the dashboard's **Settings → Matter Bridge** tab shows a QR code and a manual pairing code.
2. In the Alexa app: **Add device → More → Matter-enabled device**, then scan the QR code or enter the code manually.
3. Alexa (or an Echo/Fire TV device acting as your Matter hub) connects to DomLink directly over your LAN and commissions it as a bridge.

No credentials are ever stored for this step — Matter's own certificate-based security handles it.

### A note on Docker networking

Matter commissioning relies on mDNS (multicast DNS) and needs its operational port reachable directly on the LAN. Docker's default bridge/NAT networking blocks multicast, so `docker-compose.yml` uses `network_mode: host` (Linux only). If another Matter bridge is already running on the same host (e.g. [Matterbridge](https://github.com/Luligu/matterbridge) for Zigbee2MQTT), set `MATTER_PORT` to a free port — the default `5540` may already be taken.

## Quick start

```bash
git clone https://github.com/bmetallica/DomLink.git
cd DomLink
docker compose up -d --build
```

Then open `http://<server-ip>:3001`, log in with the default password `admin`, and set a new password when prompted.

### Configuration

The container is configured entirely through the web UI after first start. A few things are set via environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the app listens on inside the container |
| `DATA_DIR` | `/app/data` | Where `config.json`, backups and Matter's own storage are kept |
| `MATTER_PORT` | `5540` | Matter's operational port — change if another Matter bridge already uses 5540 on this host |
| `COOKIE_SECURE` | `false` | Set to `true` if DomLink runs behind HTTPS/TLS |
| `DOMOTICZ_POLL_INTERVAL_MS` | `25000` | How often Domoticz devices are polled for state changes |

With `network_mode: host`, the `PORT` value is what you actually connect to on the host directly (no Docker port mapping) — adjust if `3001` is already taken.

### First-time setup in the dashboard

1. **Settings → Domoticz Verbindung**: enter your Domoticz URL/port and credentials, click "Verbindung testen", then save.
2. Go through the device tabs, toggle "Aktiv" for the devices Alexa should control, and adjust display name / Alexa type as needed.
3. **Settings → Matter Bridge**: scan the QR code (or enter the manual code) in the Alexa app to pair.
4. If you activate more devices later, either wait for Alexa to notice automatically or trigger "discover devices" in the Alexa app once — DomLink's endpoints are permanent once created (see below), so this is normally only needed after a device's very first activation.

### Why endpoints are permanent (and what that means for you)

The first time you activate a device, DomLink gives it a permanent Matter endpoint. Deactivating it later doesn't remove that endpoint again — it just marks it "unreachable" (Alexa shows it as offline). Reactivating flips it back. This means toggling devices on/off never requires re-pairing or re-discovery, and Alexa never loses track of which entity is which. The trade-off: a device you tried once and abandoned stays as a greyed-out entry in Alexa until you manually remove it there.

## Alexa voice examples

- "Alexa, turn on the office light."
- "Alexa, set the living room dimmer to 40 percent."
- "Alexa, open the blinds."
- "Alexa, what's the temperature outside?" *(reads live from Domoticz)*
- "Alexa, set the bedroom thermostat to 21 degrees."

## Live protocol view

The dashboard's **📋 Live-Protokoll** tab streams a real-time feed (via Server-Sent Events) of everything the bridge does: commands received from Alexa, the resulting Domoticz API calls, state updates pushed back to Alexa, and device registration events. Useful for diagnosing exactly which physical device a given Alexa command actually reaches.

## Data & backups

All persistent state lives in `./data` (bind-mounted into the container):

- `data/config.json` — password hash, Domoticz connection, per-device Alexa settings
- `data/backups/` — the last 15 snapshots of `config.json`, written automatically before every save
- `data/matter-storage/` — Matter's own fabric/commissioning state; deleting this requires re-pairing in Alexa

Back up the `./data` directory like you would any other stateful service.

## Security notes

- Change the default password immediately — the dashboard forces this on first login.
- Domoticz credentials are stored in `data/config.json` in plain form (needed to operate) — protect access to the host/volume accordingly.
- Set `COOKIE_SECURE=true` if you put DomLink behind a reverse proxy with HTTPS.

## Credits

The local Matter bridge is built on [`matter.js`](https://github.com/matter-js/matter.js), the open-source (Apache-2.0) TypeScript implementation of the Matter protocol. DomLink is not affiliated with or endorsed by the CSA, Amazon, or the matter.js project.

## License

[MIT](LICENSE)
