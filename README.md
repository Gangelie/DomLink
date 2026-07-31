# DomLink

**A self-hosted bridge between [Domoticz](https://www.domoticz.com/) and Amazon Alexa — no Node-RED required.**

🇬🇧 English (this file) · [🇩🇪 Deutsch](README.de.md)

---

## What is DomLink?

DomLink is a small Node.js/Express application, shipped as a single Docker container, that:

- reads all your active devices from Domoticz,
- lets you pick which ones Alexa should see, and how (switch, light, dimmer, blind, thermostat, temperature sensor),
- exposes them to Alexa through **[Virtual Smart Home](https://www.virtualsmarthome.xyz/) (VSH)** using a native, from-scratch re-implementation of VSH's cloud protocol — no Node-RED installation needed, and
- gives you a dark-mode web dashboard to manage all of it, protected by a login.

## Features

- 🔒 **Auth** — password-protected UI & API (session-based), default password `admin`, forced change on first login
- ⚙️ **Everything configurable from the UI** — Domoticz connection, VSH/Alexa linking, password — persisted to `data/config.json`, with automatic rolling backups before every save
- 🔌 **Bidirectional Domoticz integration** — On/Off, dimming, blinds and thermostat setpoints from Alexa; live sensor reads for Alexa queries ("Alexa, what's the temperature outside?")
- 🗣️ **Native VSH/Alexa bridge** — one-time Amazon device-code linking, persistent MQTT/TLS connection, Alexa directive handling and state (Change/State) reporting — all without Node-RED
- 🌓 **Dark-mode dashboard** with tabs: All devices, Lights & Dimmers, Switches & Plugs, Blinds, Sensors & Thermostats, Meters, Settings
- 🔢 **Automatic device classification** from Domoticz metadata (switch / light / dimmer / blind / temperature sensor / thermostat / meter), fully overridable per device — read-only meters/counters (kWh, voltage, gas, ...) are shown for reference but never exposed to Alexa
- 🐳 **Single container** — one Docker image, one bind-mounted data directory

## How the Alexa linking works (there is no separate "VSH account")

Virtual Smart Home doesn't have its own username/password. Linking works like pairing a streaming device:

1. DomLink requests an Amazon **device code** ("Login with Amazon").
2. You open the shown link on any browser and log into your normal **Amazon account** (the one with the Alexa/VSH Skill enabled) and approve the code.
3. DomLink exchanges that approval for an MQTT/TLS certificate from the VSH backend, tied to your Amazon account.
4. From then on, DomLink talks to Alexa over that MQTT connection — no password is stored anywhere for this step.

This flow is a native re-implementation of the protocol used by the open-source [`node-red-contrib-virtual-smart-home`](https://github.com/csuermann/node-red-contrib-virtual-smart-home) project — see [Credits](#credits).

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
| `DATA_DIR` | `/app/data` | Where `config.json` and backups are stored |
| `COOKIE_SECURE` | `false` | Set to `true` if DomLink runs behind HTTPS/TLS |
| `DOMOTICZ_POLL_INTERVAL_MS` | `25000` | How often Domoticz devices are polled for state changes |

Host port mapping (`3001:3000` by default) is set in `docker-compose.yml` — adjust if `3001` is already taken on your host.

### First-time setup in the dashboard

1. **Settings → Domoticz Verbindung**: enter your Domoticz URL/port and credentials, click "Verbindung testen", then save.
2. **Settings → Virtual Smart Home**: click "Mit Amazon verbinden", follow the device-code link, approve on Amazon.
3. Go through the device tabs, toggle "Aktiv" for the devices Alexa should control, and adjust display name / Alexa type as needed.
4. Say "Alexa, discover my devices" (or search for devices in the Alexa app).

## Alexa voice examples

- "Alexa, turn on the office light."
- "Alexa, set the living room dimmer to 40 percent."
- "Alexa, open the blinds."
- "Alexa, what's the temperature outside?" *(reads live from Domoticz)*
- "Alexa, set the bedroom thermostat to 21 degrees."

## Data & backups

All persistent state lives in `./data` (bind-mounted into the container):

- `data/config.json` — password hash, Domoticz connection, VSH/MQTT credentials, per-device Alexa settings
- `data/backups/` — the last 15 snapshots of `config.json`, written automatically before every save

Back up the `./data` directory like you would any other stateful service.

## Security notes

- Change the default password immediately — the dashboard forces this on first login.
- Domoticz credentials and VSH/MQTT certificates are stored in `data/config.json` in plain form (needed to operate) — protect access to the host/volume accordingly.
- Set `COOKIE_SECURE=true` if you put DomLink behind a reverse proxy with HTTPS.

## Credits

The Virtual Smart Home protocol (LWA device-code linking, AWS IoT/MQTT device shadow, discovery and directive handling) was re-implemented natively for DomLink based on the publicly available source of [`node-red-contrib-virtual-smart-home`](https://github.com/csuermann/node-red-contrib-virtual-smart-home) by Cornelius Suermann (MIT licensed). DomLink is not affiliated with or endorsed by Virtual Smart Home.

## License

[MIT](LICENSE)
