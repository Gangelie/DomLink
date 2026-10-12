# Codex project: DomLink (personal fork)

DomLink is a Node.js 22+ local Matter bridge between Domoticz and Amazon Alexa.
Work on a feature branch. Keep `main` deployable; do not reset Matter commissioning
or change persistent `data/` storage.

## Relevant files
- `lib/domoticz.js`: HTTP API calls to Domoticz.
- `lib/deviceTypes.js`: device classification, mapping and Domoticz state decoding.
- `lib/deviceStore.js`: synchronization, device configuration and commands.
- `lib/matterBridge.js`: Matter endpoints and Alexa events.
- `public/index.html`: dashboard SPA.
- `tests/device-control.test.js`: regression tests (mock Domoticz only).

## Established requirements
1. `Scene` and `Group` use `param=switchscene`, not `switchlight`.
2. Domoticz scenes accept `On` only. Expose scenes as **momentary** Matter
   switches and reset the *Matter state*, never the physical scene devices.
3. Groups can be `On`, `Off` or `Mixed`; report `Mixed` as `On` to a binary
   Matter switch (documented approximation), but keep true group On/Off commands.
4. Domoticz selectors expose 10-based mode levels (example: 30=Fan,
   40=Heizen). Treat them as `DIMMABLE_LIGHT` in Matter with discrete-level
   snapping; report the correct state and the mode label in the dashboard.
5. Users may have manually configured a source Selector as `DIMMER` already;
   preserve existing settings. Changing it to `SELECTOR` must not change the
   Matter template, thus avoiding endpoint recreation.
6. The **Alexa routines and names** are configured outside DomLink. A Matter
   dimmer cannot natively understand human-readable HVAC mode words.
7. Thermostats may set `temperatureSourceIdx` to a visible Domoticz device with
   a finite numeric `Temp` field and a temperature or humidity device type.
   The default remains the thermostat's own `Temp`; external readings never
   change its SetPoint command or Matter endpoint identity. Resolve readings
   from the complete `getDevices()` snapshot, including inactive Matter
   devices, and report unavailable measurements as null (never 0°C).

## Operational safety
- Never execute real Home Alarm OnActions from tests. Use mocked Domoticz APIs.
- Never call `resetCommissioning`, delete Matter storage or `docker compose down -v`.
- Do not change host-mode Matter networking or the user's
  `MATTER_MDNS_NETWORKINTERFACE` environment value (e.g., enp2s0).
- Changes must run through `npm ci`, `npm test`, `node --check`.
- For a live release, back up mounted `data/` and test with a noncritical scene
  before activating the alarm scene. Only update production on user's request.
- Review upstream changes before rebasing; preserve MIT attribution.
- Thermostat temperature-source tests must use mocked Domoticz APIs; sensor
  updates must never issue `setsetpoint`.
