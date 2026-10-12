import path from 'node:path';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import { Endpoint, Environment, ServerNode, VendorId } from '@matter/main';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import { OnOffServer } from '@matter/main/behaviors/on-off';
import { WindowCoveringServer } from '@matter/main/behaviors/window-covering';
import { ThermostatServer } from '@matter/main/behaviors/thermostat';
import { OnOffLightDevice } from '@matter/main/devices/on-off-light';
import { OnOffPlugInUnitDevice } from '@matter/main/devices/on-off-plug-in-unit';
import { DimmableLightDevice } from '@matter/main/devices/dimmable-light';
import { WindowCoveringDevice } from '@matter/main/devices/window-covering';
import { ThermostatDevice } from '@matter/main/devices/thermostat';
import { TemperatureSensorDevice } from '@matter/main/devices/temperature-sensor';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import * as eventLog from './eventLog.js';

// --- Unit conversions between DomLink's internal state (percent-based, 0-100,
// Celsius as plain numbers) and Matter's cluster attribute units. Verified
// against the Matter Device Library / cluster spec via the matter.js source
// (see conversation notes) rather than assumed:
//   - TemperatureMeasurement/Thermostat "temperature" datatype: int16, 0.01°C
//     units (MinMeasuredValue default -27315 = -273.15°C confirms the scale).
//   - LevelControl CurrentLevel: uint8, 1-254 (MinLevel default 1, max 254).
//   - WindowCovering *PositionLiftPercent100ths: 0.01% units, and critically
//     0% = fully OPEN (UpOrOpen), 100% (10000) = fully CLOSED (DownOrClose) -
//     the OPPOSITE of DomLink's internal `percentage` (100 = open, matching
//     Domoticz/legacy convention), so this direction must be inverted.
function brightnessToMatterLevel(percent) {
  return Math.max(1, Math.min(254, Math.round((percent / 100) * 254)));
}
function matterLevelToBrightness(level) {
  return Math.max(0, Math.min(100, Math.round((level / 254) * 100)));
}
// Matter's "temperature" datatype is int16 in 0.01°C units: -273.00°C to
// 327.67°C. Meters repurposed as a TEMPERATURE_SENSOR (see deviceTypes.js)
// can easily produce a raw value outside that range (e.g. a Watt or kWh
// reading) - clamp rather than let it overflow and fail cluster validation,
// which previously crashed the whole endpoint (and, worse, the whole bridge
// startup loop) for a single out-of-range device.
function celsiusToMatter(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(-27300, Math.min(32767, Math.round(numeric * 100)));
}
function matterToCelsius(value) {
  return value / 100;
}
function percentOpenToMatterLift100ths(percentOpen) {
  return Math.max(0, Math.min(10000, Math.round((100 - percentOpen) * 100)));
}
function matterLift100thsToPercentOpen(lift100ths) {
  return Math.max(0, Math.min(100, Math.round(100 - lift100ths / 100)));
}

// Short human-readable summary of a DomLink state object, for the live log.
function describeState(state) {
  const parts = [];
  if (state.powerState !== undefined) parts.push(state.powerState === 'ON' ? 'An' : 'Aus');
  if (state.brightness !== undefined) parts.push(`${state.brightness}%`);
  if (state.percentage !== undefined) parts.push(`${state.percentage}%`);
  if (state.temperature !== undefined) parts.push(`${state.temperature}°C`);
  if (state.targetTemperature !== undefined) parts.push(`Soll ${state.targetTemperature}°C`);
  return parts.join(', ') || '–';
}

const LiftingWindowCoveringServer = WindowCoveringServer.with('Lift', 'PositionAwareLift');
const HeatingThermostatServer = ThermostatServer.with('Heating');

// matter.js's default OnOff command handlers (on()/off()) run unconditionally
// on every invocation - Alexa really does resend "TurnOn" even when it
// believes the device is already on. But `this.state.onOff = true` when the
// value is already true doesn't count as a *change*, so an onOff$Changed
// listener never fires for a repeated same-direction command - many Domoticz
// devices (RF/433MHz switches, momentary blind-lift relays) have no real
// feedback loop, so this repeatedly "eats" commands that should go through.
// Hooking the command methods directly instead of the change event catches
// every invocation regardless of whether the attribute value actually moves.
let activeBridgeInstance = null;

class RoutingOnOffServer extends OnOffServer {
  on() {
    const result = super.on();
    activeBridgeInstance?._handleOnOffCommand(this.endpoint.id, true);
    return result;
  }

  off() {
    const result = super.off();
    activeBridgeInstance?._handleOnOffCommand(this.endpoint.id, false);
    return result;
  }
}

// Every bridged device needs BridgedDeviceBasicInformationServer composed in;
// WindowCovering/Thermostat additionally need their feature-selected server.
const MATTER_DEVICE_TYPE = {
  ONOFF_PLUG: OnOffPlugInUnitDevice.with(RoutingOnOffServer, BridgedDeviceBasicInformationServer),
  ONOFF_LIGHT: OnOffLightDevice.with(RoutingOnOffServer, BridgedDeviceBasicInformationServer),
  DIMMABLE_LIGHT: DimmableLightDevice.with(RoutingOnOffServer, BridgedDeviceBasicInformationServer),
  WINDOW_COVERING: WindowCoveringDevice.with(LiftingWindowCoveringServer, BridgedDeviceBasicInformationServer),
  TEMPERATURE_SENSOR: TemperatureSensorDevice.with(BridgedDeviceBasicInformationServer),
  THERMOSTAT: ThermostatDevice.with(HeatingThermostatServer, BridgedDeviceBasicInformationServer),
};

// Native local Matter bridge, replacing the old VSH cloud bridge. Exposes
// active Domoticz devices as Matter endpoints under a single Aggregator node
// that's commissioned directly into Alexa's (or any other ecosystem's) Matter
// fabric - no cloud account, no device-count plan limits.
export default class MatterBridge extends EventEmitter {
  constructor({ deviceStore, dataDir, logger = console }) {
    super();
    this.deviceStore = deviceStore;
    this.dataDir = dataDir;
    this.logger = logger;

    this.server = null;
    this.aggregator = null;
    this.endpoints = new Map(); // deviceId -> Endpoint

    this.deviceStore.on('change', (changes) => {
      this._onDomoticzChanges(changes).catch((e) => this.logger.error('Matter: state push fehlgeschlagen:', e.message));
    });
    this.deviceStore.on('config-changed', ({ before, after }) => {
      this._onConfigChanged(before, after).catch((e) => this.logger.error('Matter: config-changed fehlgeschlagen:', e.message));
    });
  }

  async start() {
    activeBridgeInstance = this;

    const storagePath = path.join(this.dataDir, 'matter-storage');
    Environment.default.vars.set('storage.path', storagePath);

    // Default 5540 is Matter's conventional operational port, but that's
    // already taken on hosts running another Matter bridge (e.g. Matterbridge
    // for Zigbee2MQTT) - override via MATTER_PORT if needed.
    const matterPort = Number(process.env.MATTER_PORT || 5540);

    this.server = await ServerNode.create({
      id: 'domlink-bridge',
      network: { port: matterPort },
      productDescription: {
        name: 'DomLink',
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorName: 'DomLink',
        vendorId: VendorId(0xfff1),
        nodeLabel: 'DomLink Bridge',
        productName: 'DomLink Domoticz Bridge',
        productLabel: 'DomLink Domoticz Bridge',
        productId: 0x8000,
        serialNumber: 'domlink-bridge-0001',
        uniqueId: 'domlink-bridge-0001',
      },
    });

    this.aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await this.server.add(this.aggregator);

    for (const record of this.deviceStore.getRegisteredDevices()) {
      try {
        await this._addEndpoint(record);
      } catch (err) {
        // A single malformed/out-of-range device must never take the whole
        // bridge down - skip it and keep going.
        this.logger.error(`Matter: Gerät ${record.deviceId} (${record.domoticzName}) konnte nicht hinzugefügt werden:`, err.message);
        eventLog.log('matter', 'error', `Gerät konnte nicht hinzugefügt werden: ${record.domoticzName} (${err.message})`, record.domoticzName);
      }
    }

    this.server.lifecycle.commissioned.on(() => {
      this.logger.log('Matter: Bridge wurde kommissioniert');
      eventLog.log('matter', 'info', 'Bridge wurde mit einem Controller (z. B. Alexa) gekoppelt');
    });
    this.server.lifecycle.decommissioned.on(() => {
      this.logger.log('Matter: Bridge wurde zurückgesetzt');
      eventLog.log('matter', 'warn', 'Bridge-Kopplung wurde zurückgesetzt');
    });
    this.server.lifecycle.online.on(() => {
      this.logger.log('Matter: Bridge ist online');
      eventLog.log('matter', 'info', 'Bridge ist online');
    });
    this.server.lifecycle.offline.on(() => {
      this.logger.log('Matter: Bridge ist offline');
      eventLog.log('matter', 'warn', 'Bridge ist offline');
    });

    await this.server.start();

    this.logger.log(`Matter-Bridge gestartet. Kommissioniert: ${this.server.lifecycle.isCommissioned}`);
  }

  async stop() {
    if (activeBridgeInstance === this) activeBridgeInstance = null;
    if (!this.server) return;
    await this.server.close();
    this.server = null;
    this.aggregator = null;
    this.endpoints.clear();
  }

  async resetCommissioning() {
    if (!this.server) throw new Error('Matter-Bridge läuft nicht');
    await this.server.erase();
    await this.stop();
    await this.start();
  }

  getStatus() {
    if (!this.server) {
      return { running: false, commissioned: false, online: false, deviceCount: 0, pairingCode: null };
    }

    const isCommissioned = this.server.lifecycle.isCommissioned;
    let pairingCode = null;
    if (!isCommissioned) {
      const codes = this.server.state.commissioning.pairingCodes;
      pairingCode = { qr: codes.qrPairingCode, manual: codes.manualPairingCode };
    }

    return {
      running: true,
      commissioned: isCommissioned,
      online: this.server.lifecycle.isOnline,
      deviceCount: this.endpoints.size,
      pairingCode,
    };
  }

  async getPairingQrCodeDataUrl() {
    const status = this.getStatus();
    if (!status.pairingCode) return null;
    return QRCode.toDataURL(status.pairingCode.qr, { margin: 1, width: 280 });
  }

  // ---------------------------------------------------------------------
  // Endpoint lifecycle
  // ---------------------------------------------------------------------

  async _addEndpoint(record) {
    const { deviceId, idx, template, state } = record;
    if (this.endpoints.has(deviceId)) return;

    const deviceType = MATTER_DEVICE_TYPE[template];
    if (!deviceType) return; // METER or unknown - never bridged

    const name = (record.alexaName || record.domoticzName || `Domoticz ${idx}`).slice(0, 32);

    // Some clusters (notably Thermostat) have mandatory attributes with no
    // schema default - they must be present in the endpoint's initial state
    // at construction time, not set afterwards, or validation fails and the
    // whole endpoint is rolled back.
    const endpoint = new Endpoint(deviceType, {
      id: `d${idx}`,
      bridgedDeviceBasicInformation: {
        nodeLabel: name,
        productName: name,
        productLabel: name,
        serialNumber: `domlink-${idx}`,
        reachable: record.active,
      },
      ...this._stateToClusterPatch(template, state),
    });

    await this.aggregator.add(endpoint);
    this.endpoints.set(deviceId, endpoint);

    this._wireCommandEvents(deviceId, template, endpoint);

    this.logger.log(`Matter: Gerät hinzugefügt: ${name} (${deviceId}, ${template})`);
    eventLog.log('matter', 'info', `Gerät registriert: ${name}`, name);
  }

  async _removeEndpoint(deviceId) {
    const endpoint = this.endpoints.get(deviceId);
    if (!endpoint) return;
    const record = this.deviceStore.getByDeviceId(deviceId);
    const name = record ? record.alexaName || record.domoticzName : deviceId;
    await endpoint.close();
    this.endpoints.delete(deviceId);
    this.logger.log(`Matter: Gerät entfernt: ${deviceId}`);
    eventLog.log('matter', 'warn', `Gerät entfernt: ${name}`, name);
  }

  // Shared by both the OnOff command routing (_handleOnOffCommand) and the
  // remaining $Changed-based listeners below.
  async _applyCommand(deviceId, patch, commandLabel) {
    const record = this.deviceStore.getByDeviceId(deviceId);
    const name = record ? record.alexaName || record.domoticzName : deviceId;

    eventLog.log('matter', 'info', `Alexa → ${name}: ${commandLabel}`, name);

    const isScene = String(record?.raw?.Type || '').trim().toLowerCase() === 'scene';
    try {
      await this.deviceStore.applyStateChange(deviceId, patch);
    } catch (e) {
      this.logger.error(`Matter: Befehl für ${deviceId} fehlgeschlagen:`, e.message);
      eventLog.log('matter', 'error', `Fehler bei ${name}: ${e.message}`, name);
    } finally {
      // Scenes are actions: return their *Matter* switch to Off after each
      // request, without turning off physical devices or firing Domoticz
      // group OffActions. A failed command should also remain retryable.
      if (isScene) {
        const endpoint = this.endpoints.get(deviceId);
        if (endpoint) {
          try {
            await this._pushState(endpoint, record.template, { powerState: 'OFF' });
          } catch (e) {
            this.logger.error(`Matter: Scene-Reset für ${deviceId} fehlgeschlagen:`, e.message);
          }
        }
      }
    }
  }

  // Invoked by RoutingOnOffServer's on()/off() overrides for every OnOff
  // command Alexa sends - including repeats of the currently-reported value,
  // which matter.js's onOff$Changed event (used for every other cluster
  // below) silently swallows since it only fires on an actual value change.
  // Many Domoticz devices (433 MHz switches, momentary blind-lift relays)
  // have no real feedback loop and must always re-execute the command.
  _handleOnOffCommand(endpointStringId, value) {
    const idx = endpointStringId.replace(/^d/, '');
    const deviceId = `domlink-${idx}`;
    if (!this.endpoints.has(deviceId)) return;
    this._applyCommand(deviceId, { powerState: value ? 'ON' : 'OFF' }, value ? 'Einschalten' : 'Ausschalten').catch(
      () => {}
    );
  }

  _wireCommandEvents(deviceId, template, endpoint) {
    switch (template) {
      case 'DIMMABLE_LIGHT':
        endpoint.events.levelControl.currentLevel$Changed.on((value) => {
          if (value === null || value === undefined) return;
          const pct = matterLevelToBrightness(value);
          this._applyCommand(deviceId, { brightness: pct, powerState: pct > 0 ? 'ON' : 'OFF' }, `Helligkeit ${pct}%`);
        });
        break;

      case 'WINDOW_COVERING':
        endpoint.events.windowCovering.currentPositionLiftPercent100ths$Changed.on((value) => {
          if (value === null || value === undefined) return;
          const pct = matterLift100thsToPercentOpen(value);
          this._applyCommand(deviceId, { percentage: pct }, `Position ${pct}%`);
        });
        break;

      case 'THERMOSTAT':
        endpoint.events.thermostat.occupiedHeatingSetpoint$Changed.on((value) => {
          if (value === null || value === undefined) return;
          const temp = matterToCelsius(value);
          this._applyCommand(deviceId, { targetTemperature: temp }, `Solltemperatur ${temp}°C`);
        });
        break;

      default:
        break;
    }
  }

  // Build the Matter cluster-state patch for a DomLink internal `state`
  // object (Domoticz -> Alexa direction). Used both as the endpoint's initial
  // construction state and for later updates via endpoint.set().
  _stateToClusterPatch(template, state) {
    const patch = {};

    switch (template) {
      case 'ONOFF_PLUG':
      case 'ONOFF_LIGHT':
        patch.onOff = { onOff: state.powerState === 'ON' };
        break;
      case 'DIMMABLE_LIGHT':
        patch.onOff = { onOff: state.powerState === 'ON' };
        patch.levelControl = { currentLevel: brightnessToMatterLevel(state.brightness) };
        break;
      case 'WINDOW_COVERING': {
        const lift = percentOpenToMatterLift100ths(state.percentage);
        patch.windowCovering = { currentPositionLiftPercent100ths: lift, targetPositionLiftPercent100ths: lift };
        break;
      }
      case 'TEMPERATURE_SENSOR':
        patch.temperatureMeasurement = { measuredValue: celsiusToMatter(state.temperature) };
        break;
      case 'THERMOSTAT':
        patch.thermostat = {
          localTemperature: celsiusToMatter(state.temperature),
          occupiedHeatingSetpoint: celsiusToMatter(state.targetTemperature),
          // Both mandatory once the Heating feature is enabled, neither has a
          // schema default - must always be supplied or the endpoint fails
          // validation. Domoticz SetPoint devices have no mode concept of
          // their own, so this is hardcoded to a plain heating thermostat.
          systemMode: 4, // SystemModeEnum.Heat
          controlSequenceOfOperation: 2, // ControlSequenceOfOperationEnum.HeatingOnly
        };
        break;
      default:
        return {};
    }

    return patch;
  }

  async _pushState(endpoint, template, state) {
    const patch = this._stateToClusterPatch(template, state);
    if (Object.keys(patch).length === 0) return;
    await endpoint.set(patch);
  }

  // ---------------------------------------------------------------------
  // DeviceStore event handlers
  // ---------------------------------------------------------------------

  async _onDomoticzChanges(changes) {
    for (const change of changes) {
      const endpoint = this.endpoints.get(change.deviceId);
      if (!endpoint) continue;
      const record = this.deviceStore.getByDeviceId(change.deviceId);
      const name = record ? record.alexaName || record.domoticzName : change.deviceId;
      eventLog.log('domoticz', 'info', `Domoticz → Alexa: ${name} (${describeState(change.newState)})`, name);
      await this._pushState(endpoint, change.template, change.newState);
    }
  }

  // Endpoints are permanent once created: toggling "Aktiv" off/on again never
  // removes and recreates the endpoint (that would let its numeric endpoint
  // number get reused for a *different* device - which is exactly what once
  // caused Alexa to associate a stale friendly name with the wrong endpoint
  // after rapid activate/deactivate cycling). Instead, deactivating just
  // flips the standard Matter "Reachable" attribute; the endpoint's identity
  // stays stable for the life of the bridge.
  async _onConfigChanged(before, after) {
    if (!this.server) return;

    // Meters (or any device without a Matter device type) can never have a
    // Matter presence - remove the endpoint if one somehow exists and stop.
    if (after.template === null) {
      if (this.endpoints.has(after.deviceId)) {
        await this._removeEndpoint(after.deviceId);
      }
      return;
    }

    // Not yet activated for the first time - nothing to expose yet.
    if (!after.matterRegistered) return;

    const existingEndpoint = this.endpoints.get(after.deviceId);

    if (!existingEndpoint) {
      // First-ever registration (or the bridge restarted before this ran).
      await this._addEndpoint(after);
      return;
    }

    if (before.template !== after.template) {
      // Device kind changed (e.g. Alexa Typ manually reassigned) - Matter
      // endpoints can't change type in place, so this specific case still
      // needs a recreate.
      await this._removeEndpoint(after.deviceId);
      await this._addEndpoint(after);
      return;
    }

    const infoPatch = {};
    const name = after.alexaName || after.domoticzName;

    if (before.active !== after.active) {
      infoPatch.reachable = after.active;
      eventLog.log(
        'matter',
        'info',
        after.active ? `${name}: wieder erreichbar` : `${name}: deaktiviert (bleibt in Alexa registriert, aber nicht erreichbar)`,
        name
      );
    }
    if (before.alexaName !== after.alexaName) {
      const label = name.slice(0, 32);
      infoPatch.nodeLabel = label;
      infoPatch.productName = label;
      infoPatch.productLabel = label;
    }
    if (Object.keys(infoPatch).length > 0) {
      await existingEndpoint.set({ bridgedDeviceBasicInformation: infoPatch });
    }

    // Covers valueField changes and generally keeps cluster state in sync.
    await this._pushState(existingEndpoint, after.template, after.state);
  }
}
