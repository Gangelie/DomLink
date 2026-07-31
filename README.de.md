# DomLink

**Eine selbst gehostete, lokale Brücke zwischen [Domoticz](https://www.domoticz.com/) und Amazon Alexa — ganz ohne Node-RED, ohne Cloud-Konto, ohne Drittanbieter-Dienst.**

[🇬🇧 English](README.md) · 🇩🇪 Deutsch (diese Datei)

---

## Was ist DomLink?

DomLink ist eine kleine Node.js/Express-Anwendung, die als einzelner Docker-Container läuft und:

- alle aktiven Geräte aus Domoticz ausliest,
- dir erlaubt auszuwählen, welche davon Alexa sehen soll und als was (Schalter, Licht, Dimmer, Rollladen, Thermostat, Temperatursensor),
- diese Geräte für Alexa freigibt, indem sie eine **eigene lokale [Matter](https://csa-iot.org/all-solutions/matter/)-Bridge** betreibt — direkt aus der Alexa-App gekoppelt, komplett in deinem eigenen Netzwerk, und
- dir ein durch Login geschütztes Dark-Mode-Dashboard zur Verwaltung bereitstellt, inklusive Live-Protokoll fürs Debugging.

## Funktionen

- 🔒 **Zugriffsschutz** — Passwortschutz für UI & API (Session-basiert), Standardpasswort `admin`, erzwungene Änderung beim ersten Login
- ⚙️ **Alles über die Oberfläche konfigurierbar** — Domoticz-Verbindung, Geräteauswahl, Passwort — gespeichert in `data/config.json`, mit automatischem rollierendem Backup vor jedem Speichern
- 🔌 **Bidirektionale Domoticz-Integration** — Ein/Aus, Dimmen, Rollläden und Thermostat-Sollwerte von Alexa aus steuerbar; Live-Sensorwerte werden an Alexa zurückgemeldet
- 🗣️ **Native lokale Matter-Bridge** — kein Cloud-Konto, keine Geräte-Limits, kein Node-RED. Einmalig per QR-Code oder manuellem Code direkt in der Alexa-App koppeln
- 📋 **Live-Protokoll** — sieh in Echtzeit im Dashboard, welche Befehle von Alexa kommen und was sie bei Domoticz auslösen (und umgekehrt) — unschätzbar wertvoll beim Debuggen von Geräte-Verwechslungen
- 🌓 **Dark-Mode-Dashboard** mit Reitern: Alle Geräte, Lichter & Dimmer, Schalter & Steckdosen, Rollläden/Jalousien, Sensoren & Thermostate, Zähler, Einstellungen
- 🔢 **Automatische Geräteklassifizierung** anhand der Domoticz-Metadaten (Schalter / Licht / Dimmer / Rollladen / Temperatursensor / Thermostat / Zähler), pro Gerät frei überschreibbar — reine Zähler (kWh, Spannung, Gas, ...) werden nur zur Übersicht angezeigt und standardmäßig nie an Alexa weitergegeben
- 🐳 **Ein einziger Container** — ein Docker-Image, ein Bind-Mount-Datenverzeichnis

## Wie die Alexa-Kopplung funktioniert (kein Cloud-Konto nötig)

Matter-Geräte werden direkt in deinem lokalen Netzwerk gekoppelt — kein Amazon-Entwicklerkonto, kein Drittanbieter-Cloud-Dienst:

1. DomLink starten; im Dashboard unter **Einstellungen → Matter Bridge** erscheinen ein QR-Code und ein manueller Kopplungscode.
2. In der Alexa-App: **Gerät hinzufügen → Weiteres → Matter-fähiges Gerät**, dann QR-Code scannen oder Code manuell eingeben.
3. Alexa (bzw. ein Echo- oder Fire-TV-Gerät als dein Matter-Hub) verbindet sich direkt über dein LAN mit DomLink und kommissioniert es als Bridge.

Für diesen Schritt wird nirgends ein Passwort gespeichert — Matters eigene zertifikatsbasierte Sicherheit übernimmt das.

### Hinweis zum Docker-Netzwerk

Matter-Kopplung basiert auf mDNS (Multicast-DNS) und braucht den Matter-Betriebsport direkt im LAN erreichbar. Dockers Standard-Bridge/NAT-Netzwerk blockiert Multicast, daher nutzt `docker-compose.yml` `network_mode: host` (nur Linux). Falls auf demselben Host bereits eine andere Matter-Bridge läuft (z. B. [Matterbridge](https://github.com/Luligu/matterbridge) für Zigbee2MQTT), setze `MATTER_PORT` auf einen freien Port — der Standard `5540` könnte schon belegt sein.

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
| `DATA_DIR` | `/app/data` | Ablageort für `config.json`, Backups und Matters eigenen Speicher |
| `MATTER_PORT` | `5540` | Matters Betriebsport — ändern, falls auf diesem Host schon eine andere Matter-Bridge Port 5540 belegt |
| `COOKIE_SECURE` | `false` | Auf `true` setzen, wenn DomLink hinter HTTPS/TLS läuft |
| `DOMOTICZ_POLL_INTERVAL_MS` | `25000` | Abfrageintervall für Domoticz-Gerätestatus |

Bei `network_mode: host` ist der `PORT`-Wert direkt der, mit dem du dich auf dem Host verbindest (kein Docker-Port-Mapping) — anpassen, falls Port `3001` bereits belegt ist.

### Ersteinrichtung im Dashboard

1. **Einstellungen → Domoticz Verbindung**: URL/Port und Zugangsdaten eintragen, "Verbindung testen" klicken, dann speichern.
2. In den Geräte-Reitern die gewünschten Geräte auf "Aktiv" setzen und Anzeigename/Alexa-Typ bei Bedarf anpassen.
3. **Einstellungen → Matter Bridge**: QR-Code scannen (oder manuellen Code eingeben) in der Alexa-App, um zu koppeln.
4. Aktivierst du später weitere Geräte, entweder abwarten, bis Alexa sie automatisch bemerkt, oder einmalig "Geräte entdecken" in der Alexa-App anstoßen — DomLinks Endpunkte sind nach der ersten Aktivierung dauerhaft (siehe unten), daher ist das normalerweise nur nach der allerersten Aktivierung eines Geräts nötig.

### Warum Endpunkte dauerhaft sind (und was das für dich bedeutet)

Beim ersten Aktivieren bekommt ein Gerät einen dauerhaften Matter-Endpunkt. Deaktivierst du es später, wird dieser Endpunkt nicht wieder entfernt — er wird nur als "nicht erreichbar" markiert (Alexa zeigt ihn als offline). Reaktivieren setzt das zurück. Dadurch erfordert das Umschalten von Geräten nie erneutes Koppeln oder Neuerkennen, und Alexa verliert nie die Zuordnung, welche Kachel zu welchem Gerät gehört. Der Kompromiss: ein Gerät, das du mal ausprobiert und wieder verworfen hast, bleibt als ausgegrauter Eintrag in Alexa, bis du ihn dort manuell entfernst.

## Beispiele für Sprachbefehle

- "Alexa, schalte das Bürolicht ein."
- "Alexa, stelle den Dimmer im Wohnzimmer auf 40 Prozent."
- "Alexa, öffne die Rollläden."
- "Alexa, wie ist die Temperatur draußen?" *(liest live aus Domoticz)*
- "Alexa, stelle das Thermostat im Schlafzimmer auf 21 Grad."

## Live-Protokoll

Der Reiter **📋 Live-Protokoll** im Dashboard zeigt live (per Server-Sent Events) alles, was die Bridge tut: Befehle von Alexa, die daraus resultierenden Domoticz-API-Aufrufe, Statusmeldungen zurück an Alexa und Geräte-Registrierungsereignisse. Praktisch, um genau nachzuvollziehen, welches physische Gerät ein bestimmter Alexa-Befehl tatsächlich erreicht.

## Daten & Backups

Sämtliche dauerhaften Daten liegen in `./data` (in den Container gemountet):

- `data/config.json` — Passwort-Hash, Domoticz-Verbindung, Alexa-Einstellungen je Gerät
- `data/backups/` — die letzten 15 Sicherungen von `config.json`, automatisch vor jedem Speichern angelegt
- `data/matter-storage/` — Matters eigener Fabric-/Kopplungsstatus; wird dieser gelöscht, muss in Alexa neu gekoppelt werden

Sichere das Verzeichnis `./data` wie jeden anderen zustandsbehafteten Dienst.

## Sicherheitshinweise

- Ändere das Standardpasswort sofort — das Dashboard erzwingt dies beim ersten Login.
- Domoticz-Zugangsdaten werden im Klartext in `data/config.json` gespeichert (für den Betrieb erforderlich) — Zugriff auf Host/Volume entsprechend absichern.
- `COOKIE_SECURE=true` setzen, wenn DomLink hinter einem Reverse-Proxy mit HTTPS betrieben wird.

## Credits

Die lokale Matter-Bridge basiert auf [`matter.js`](https://github.com/matter-js/matter.js), der quelloffenen (Apache-2.0) TypeScript-Implementierung des Matter-Protokolls. DomLink steht in keiner Verbindung zur CSA, zu Amazon oder zum matter.js-Projekt und wird von keinem davon unterstützt.

## Lizenz

[MIT](LICENSE)
