# DomLink

**Eine selbst gehostete Brücke zwischen [Domoticz](https://www.domoticz.com/) und Amazon Alexa — ganz ohne Node-RED.**

[🇬🇧 English](README.md) · 🇩🇪 Deutsch (diese Datei)

---

## Was ist DomLink?

DomLink ist eine kleine Node.js/Express-Anwendung, die als einzelner Docker-Container läuft und:

- alle aktiven Geräte aus Domoticz ausliest,
- dir erlaubt auszuwählen, welche davon Alexa sehen soll und als was (Schalter, Licht, Dimmer, Rollladen, Thermostat, Temperatursensor),
- diese Geräte über **[Virtual Smart Home](https://www.virtualsmarthome.xyz/) (VSH)** für Alexa freigibt — mittels einer eigenständigen, von Grund auf neu implementierten Version des VSH-Cloud-Protokolls, ganz ohne Node-RED-Installation, und
- dir ein durch Login geschütztes Dark-Mode-Dashboard zur Verwaltung bereitstellt.

## Funktionen

- 🔒 **Zugriffsschutz** — Passwortschutz für UI & API (Session-basiert), Standardpasswort `admin`, erzwungene Änderung beim ersten Login
- ⚙️ **Alles über die Oberfläche konfigurierbar** — Domoticz-Verbindung, VSH/Alexa-Verknüpfung, Passwort — gespeichert in `data/config.json`, mit automatischem rollierendem Backup vor jedem Speichern
- 🔌 **Bidirektionale Domoticz-Integration** — Ein/Aus, Dimmen, Rollläden und Thermostat-Sollwerte von Alexa aus steuerbar; Live-Sensorabfragen für Alexa-Anfragen ("Alexa, wie ist die Temperatur draußen?")
- 🗣️ **Native VSH/Alexa-Bridge** — einmalige Verknüpfung per Amazon-Gerätecode, dauerhafte MQTT/TLS-Verbindung, Verarbeitung von Alexa-Direktiven sowie Status-/Änderungsmeldungen — alles ohne Node-RED
- 🌓 **Dark-Mode-Dashboard** mit Reitern: Alle Geräte, Lichter & Dimmer, Schalter & Steckdosen, Rollläden/Jalousien, Sensoren & Thermostate, Zähler, Einstellungen
- 🔢 **Automatische Geräteklassifizierung** anhand der Domoticz-Metadaten (Schalter / Licht / Dimmer / Rollladen / Temperatursensor / Thermostat / Zähler), pro Gerät frei überschreibbar — reine Zähler (kWh, Spannung, Gas, ...) werden nur zur Übersicht angezeigt und nie an Alexa weitergegeben
- 🐳 **Ein einziger Container** — ein Docker-Image, ein Bind-Mount-Datenverzeichnis

## Wie die Alexa-Verknüpfung funktioniert (es gibt kein separates „VSH-Konto“)

Virtual Smart Home hat keinen eigenen Benutzernamen/Passwort-Login. Die Verknüpfung funktioniert wie beim Koppeln eines Streaming-Geräts:

1. DomLink fordert einen Amazon-**Gerätecode** an ("Login with Amazon").
2. Du öffnest den angezeigten Link in einem beliebigen Browser, meldest dich mit deinem normalen **Amazon-Konto** an (dem, auf dem der Alexa/VSH-Skill aktiviert ist) und bestätigst den Code.
3. DomLink tauscht diese Freigabe beim VSH-Backend gegen ein MQTT/TLS-Zertifikat, das an dein Amazon-Konto gebunden ist.
4. Ab diesem Zeitpunkt kommuniziert DomLink über diese MQTT-Verbindung mit Alexa — für diesen Schritt wird nirgends ein Passwort gespeichert.

Dieser Ablauf ist eine eigenständige Neuimplementierung des Protokolls, das vom Open-Source-Projekt [`node-red-contrib-virtual-smart-home`](https://github.com/csuermann/node-red-contrib-virtual-smart-home) verwendet wird — siehe [Credits](#credits).

## Schnellstart

```bash
git clone https://github.com/bmetallica/DomLink.git
cd DomLink
docker compose up -d --build
```

Anschließend `http://<server-ip>:3001` öffnen, mit dem Standardpasswort `admin` anmelden und wie aufgefordert ein neues Passwort setzen.

### Konfiguration

Der Container wird nach dem ersten Start vollständig über die Weboberfläche konfiguriert. Einige Grundeinstellungen werden über Umgebungsvariablen in `docker-compose.yml` gesetzt:

| Variable | Standard | Beschreibung |
|---|---|---|
| `PORT` | `3000` | Port, auf dem die App im Container lauscht |
| `DATA_DIR` | `/app/data` | Ablageort für `config.json` und Backups |
| `COOKIE_SECURE` | `false` | Auf `true` setzen, wenn DomLink hinter HTTPS/TLS läuft |
| `DOMOTICZ_POLL_INTERVAL_MS` | `25000` | Abfrageintervall für Domoticz-Gerätestatus |

Das Host-Port-Mapping (`3001:3000` standardmäßig) wird in `docker-compose.yml` festgelegt — anpassen, falls Port `3001` auf deinem Host bereits belegt ist.

### Ersteinrichtung im Dashboard

1. **Einstellungen → Domoticz Verbindung**: URL/Port und Zugangsdaten eintragen, "Verbindung testen" klicken, dann speichern.
2. **Einstellungen → Virtual Smart Home**: "Mit Amazon verbinden" klicken, dem Gerätecode-Link folgen, bei Amazon bestätigen.
3. In den Geräte-Reitern die gewünschten Geräte auf "Aktiv" setzen und Anzeigename/Alexa-Typ bei Bedarf anpassen.
4. "Alexa, suche nach Geräten" sagen (oder in der Alexa-App nach Geräten suchen lassen).

## Beispiele für Sprachbefehle

- "Alexa, schalte das Bürolicht ein."
- "Alexa, stelle den Dimmer im Wohnzimmer auf 40 Prozent."
- "Alexa, öffne die Rollläden."
- "Alexa, wie ist die Temperatur draußen?" *(liest live aus Domoticz)*
- "Alexa, stelle das Thermostat im Schlafzimmer auf 21 Grad."

## Daten & Backups

Sämtliche dauerhaften Daten liegen in `./data` (in den Container gemountet):

- `data/config.json` — Passwort-Hash, Domoticz-Verbindung, VSH/MQTT-Zugangsdaten, Alexa-Einstellungen je Gerät
- `data/backups/` — die letzten 15 Sicherungen von `config.json`, automatisch vor jedem Speichern angelegt

Sichere das Verzeichnis `./data` wie jeden anderen zustandsbehafteten Dienst.

## Sicherheitshinweise

- Ändere das Standardpasswort sofort — das Dashboard erzwingt dies beim ersten Login.
- Domoticz-Zugangsdaten und VSH/MQTT-Zertifikate werden im Klartext in `data/config.json` gespeichert (für den Betrieb erforderlich) — Zugriff auf Host/Volume entsprechend absichern.
- `COOKIE_SECURE=true` setzen, wenn DomLink hinter einem Reverse-Proxy mit HTTPS betrieben wird.

## Credits

Das Virtual-Smart-Home-Protokoll (Amazon-Gerätecode-Verknüpfung, AWS-IoT/MQTT-Device-Shadow, Discovery und Direktiven-Verarbeitung) wurde für DomLink eigenständig anhand des öffentlich verfügbaren Quellcodes von [`node-red-contrib-virtual-smart-home`](https://github.com/csuermann/node-red-contrib-virtual-smart-home) von Cornelius Suermann (MIT-lizenziert) neu implementiert. DomLink steht in keiner Verbindung zu und wird nicht unterstützt von Virtual Smart Home.

## Lizenz

[MIT](LICENSE)
