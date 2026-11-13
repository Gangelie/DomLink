import path from 'node:path';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import { Endpoint, Environment, ServerNode, VendorId } from '@matter/main';
// Retirement must verify the SDK's persisted number before it can complete.
// This is an installed 0.17.7 implementation API; fail closed if its shape changes.
import { ServerNodeStore } from '../node_modules/@matter/node/dist/esm/storage/server/ServerNodeStore.js';
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
import { TEMPLATE_BY_ALEXA_TYPE } from './deviceTypes.js';
import * as eventLog from './eventLog.js';
import { deviceInstanceId, matterEndpointIdentity, matterSerialNumber, retirementEntriesForIdx, retirementForDevice, retirementStorageKey } from './deviceLifecycle.js';

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
  constructor({ deviceStore, dataDir, logger = console, serverNodeFactory = (options) => ServerNode.create(options) }) {
    super();
    this.deviceStore = deviceStore;
    this.deviceStore.retiringDevices ||= new Set();
    this.dataDir = dataDir;
    this.logger = logger;
    this.serverNodeFactory = serverNodeFactory;

    this.server = null;
    this.aggregator = null;
    this.endpoints = new Map(); // deviceId -> Endpoint
    this.mutationQueue = Promise.resolve();
    this.endpointMutationQueues = new Map();
    this.endpointCommandCounts = new Map();
    this.endpointCommandWaiters = new Map();
    this.retiringDeviceIds = new Set();
    this.initializationError = null;
    this.acceptCommands = false;
    this.startPromise = null;

    this.deviceStore.on('change', (changes) => {
      this._onDomoticzChanges(changes).catch((e) => this.logger.error('Matter: state push fehlgeschlagen:', e.message));
    });
    this.deviceStore.on('config-changed', ({ before, after }) => {
      this._serializeMutation(() => this._onConfigChanged(before, after)).catch((e) => this.logger.error('Matter: config-changed fehlgeschlagen:', e.message));
    });
    this.deviceStore.on('availability-changed', (available, deviceIds) => {
      this._setReachability(available, deviceIds).catch((e) => this.logger.error('Matter: Erreichbarkeit konnte nicht aktualisiert werden:', e.message));
    });
  }

  _serializeMutation(operation) {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  _serializeEndpointMutation(deviceId, operation) {
    const previous = this.endpointMutationQueues.get(deviceId) || Promise.resolve();
    const result = previous.then(operation);
    const settled = result.catch(() => {});
    this.endpointMutationQueues.set(deviceId, settled);
    settled.finally(() => {
      if (this.endpointMutationQueues.get(deviceId) === settled) this.endpointMutationQueues.delete(deviceId);
    });
    return result;
  }

  _waitForEndpointCommands(deviceId) {
    if (!this.endpointCommandCounts.get(deviceId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.endpointCommandWaiters.get(deviceId) || [];
      waiters.push(resolve);
      this.endpointCommandWaiters.set(deviceId, waiters);
    });
  }

  _isRetirementQuarantined(deviceId) {
    if (this.retiringDeviceIds.has(deviceId)) return true;
    const record = this.deviceStore.getByDeviceId(deviceId);
    if (!record) return false;
    const state = retirementForDevice(this.deviceStore.cfg.matterRetirements, record.idx, this.deviceStore.cfg.devices?.[record.idx])?.state;
    return state === 'pending' || state === 'recovery_required' || state === 'completed';
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.server) return Promise.resolve();
    this.startPromise = this._serializeMutation(() => this._start()).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async _start() {
    this._validateRetirementRegistry();
    if (!this.deviceStore.canRestoreRegisteredEndpoints()) {
      throw new Error('Persistierte registrierte Geräte enthalten nicht unterstützte Matter-Typen');
    }
    activeBridgeInstance = this;
    this.acceptCommands = false;

    try {
      const storagePath = path.join(this.dataDir, 'matter-storage');
      Environment.default.vars.set('storage.path', storagePath);

      // Default 5540 is Matter's conventional operational port, but that's
      // already taken on hosts running another Matter bridge (e.g. Matterbridge
      // for Zigbee2MQTT) - override via MATTER_PORT if needed.
      const matterPort = Number(process.env.MATTER_PORT || 5540);

      this.server = await this.serverNodeFactory({
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

      await this._reconcileRetirements();

      const expectedCount = Object.values(this.deviceStore.cfg.devices || {}).filter((device) => device.matterRegistered === true).length;
      const registeredDevices = this.deviceStore.getRegisteredDevices();
      if (registeredDevices.length !== expectedCount || registeredDevices.some((record) => !MATTER_DEVICE_TYPE[record.template])) {
        await this.server.close().catch(() => {});
        this.server = null;
        this.aggregator = null;
        this.endpoints.clear();
        throw new Error('Matter-Endpunktmetadaten sind unvollständig oder nicht unterstützt');
      }
      for (const record of registeredDevices) {
        try {
          await this._addEndpoint(record);
        } catch (err) {
          this.logger.error(`Matter: Gerät ${record.deviceId} (${record.domoticzName}) konnte nicht hinzugefügt werden:`, err.message);
          eventLog.log('matter', 'error', `Gerät konnte nicht hinzugefügt werden: ${record.domoticzName} (${err.message})`, record.domoticzName);
          await this.server.close().catch(() => {});
          this.server = null;
          this.aggregator = null;
          this.endpoints.clear();
          throw new Error(`Registrierte Matter-Endpunkte konnten nicht vollständig wiederhergestellt werden: ${err.message}`);
        }
      }
      if (this.endpoints.size !== registeredDevices.length) {
        await this.server.close().catch(() => {});
        this.server = null;
        this.aggregator = null;
        this.endpoints.clear();
        throw new Error('Matter-Endpunktinventar ist unvollständig; Bridge wird nicht gestartet');
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

      try {
        await this.server.start();
      } catch (err) {
        await this.server.close().catch(() => {});
        this.server = null;
        this.aggregator = null;
        this.endpoints.clear();
        if (activeBridgeInstance === this) activeBridgeInstance = null;
        throw err;
      }
      this.acceptCommands = true;
      this.initializationError = null;

      this.logger.log(`Matter-Bridge gestartet. Kommissioniert: ${this.server.lifecycle.isCommissioned}`);
    } catch (err) {
      this.acceptCommands = false;
      if (this.server) await this.server.close().catch(() => {});
      this.server = null;
      this.aggregator = null;
      this.endpoints.clear();
      if (activeBridgeInstance === this) activeBridgeInstance = null;
      throw err;
    }
  }

  _validateRetirementRegistry() {
    const cfg = this.deviceStore.cfg;
    for (const [key, retirement] of Object.entries(cfg.matterRetirements || {})) {
      const idx = String(retirement?.idx ?? key.split('@', 1)[0]);
      const deviceConfig = cfg.devices?.[idx];
      if (!['pending', 'recovery_required', 'completed'].includes(retirement?.state)
        || String(retirement.idx) !== idx
        || retirement.deviceId !== deviceInstanceId(idx, retirement)
        || retirement.matterEndpointId !== matterEndpointIdentity(idx, retirement)
        || !Number.isInteger(retirement.endpointNumber)
        || retirement.endpointNumber < 1
        || retirement.endpointNumber >= 0xffff
        || (!deviceConfig && !retirement.template)
        || !(Object.values(TEMPLATE_BY_ALEXA_TYPE).includes(retirement.template)
          || TEMPLATE_BY_ALEXA_TYPE[retirement.template || deviceConfig?.alexaType || 'SWITCH'])) {
        throw new Error(`Matter-Ruhestellung für IDX ${idx} ist ungültig; Bridge-Start wird abgebrochen`);
      }
      const sameGeneration = deviceConfig && String(deviceConfig.instanceId ?? '') === String(retirement.instanceId ?? '');
      if (retirement.state === 'completed' && sameGeneration && deviceConfig.matterRegistered === true) {
        retirement.state = 'recovery_required';
        retirement.updatedAt = new Date().toISOString();
        try { this.deviceStore.persist(); } catch {}
        throw new Error(`Matter-Ruhestellung für IDX ${idx} widerspricht matterRegistered=true; Bridge-Start wird abgebrochen`);
      }
    }
  }

  _sdkStoredEndpointReservation(idx, template, endpointId = `d${idx}`) {
    if (!this.server || !this.aggregator || !MATTER_DEVICE_TYPE[template]) {
      throw new Error('SDK-Endpunktspeicher ist nicht verfügbar');
    }
    const nodeStore = this.server.env.get(ServerNodeStore);
    const aggregatorStore = nodeStore.endpointStores.storeForEndpoint(this.aggregator);
    const probe = new Endpoint(MATTER_DEVICE_TYPE[template], { id: endpointId });
    const number = aggregatorStore.childStoreFor(probe).number;
    const owners = [];
    aggregatorStore.visit((store) => {
      if (number !== undefined && store.number === number) owners.push(store.id);
    });
    return { number, owners };
  }

  async _reconcileRetirements() {
    const cfg = this.deviceStore.cfg;
    for (const [key, retirement] of Object.entries(cfg.matterRetirements || {})) {
      const idx = String(retirement.idx ?? key.split('@', 1)[0]);
      const deviceConfig = cfg.devices[idx];
      const sameGeneration = deviceConfig && String(deviceConfig.instanceId ?? '') === String(retirement.instanceId ?? '');
      const record = sameGeneration ? this.deviceStore.getByDeviceId(retirement.deviceId) : null;
      const template = retirement.template || record?.template;
      if (!template || !MATTER_DEVICE_TYPE[template]) {
        throw new Error(`Matter-Ruhestellung für IDX ${idx} kann keinem unterstützten Gerätetyp zugeordnet werden`);
      }
      if (this.endpoints.has(retirement.deviceId) || this.aggregator.parts.find((part) => part.id === retirement.matterEndpointId)) {
        throw new Error(`Matter-Endpunkt ${retirement.matterEndpointId} ist trotz Ruhestellung aktiv; Bridge-Start wird abgebrochen`);
      }
      const reservation = this._sdkStoredEndpointReservation(idx, template, retirement.matterEndpointId);
      if (reservation.number !== retirement.endpointNumber
        || reservation.owners.length !== 1
        || reservation.owners[0] !== retirement.matterEndpointId) {
        retirement.state = 'recovery_required';
        retirement.updatedAt = new Date().toISOString();
        try { this.deviceStore.persist(); } catch {}
        throw new Error(`SDK-Endpunktnummer für IDX ${idx} stimmt nicht mit der Ruhestellung überein; Bridge-Start wird abgebrochen`);
      }
      if (retirement.state === 'completed') continue;
      if (!record || !sameGeneration) {
        throw new Error(`Offene Matter-Ruhestellung für IDX ${idx} hat keine eindeutige aktuelle Gerätegeneration; Bridge-Start wird abgebrochen`);
      }

      // Reconstruct the exact child while the Matter server is still unpublished,
      // verify SDK identity and number, then close it before exposing the bridge.
      try {
        await this._addEndpoint(record);
        const endpoint = this.endpoints.get(record.deviceId);
        if (!endpoint || endpoint.id !== retirement.matterEndpointId
          || endpoint.number !== retirement.endpointNumber
          || endpoint.owner !== this.aggregator
          || !this.aggregator.parts.has(endpoint)) {
          throw new Error('Wiederhergestellter Endpunkt stimmt nicht mit der Ruhestellung überein');
        }
        await endpoint.close();
        if (this.aggregator.parts.has(endpoint) || endpoint.owner !== undefined) {
          throw new Error('Wiederhergestellter Endpunkt konnte nicht sicher geschlossen werden');
        }
        this.endpoints.delete(record.deviceId);
        deviceConfig.matterRegistered = false;
        record.matterRegistered = false;
        retirement.state = 'completed';
        retirement.completedAt = new Date().toISOString();
        delete retirement.error;
        this.deviceStore.persist();
      } catch (error) {
        retirement.state = 'recovery_required';
        retirement.updatedAt = new Date().toISOString();
        retirement.error = String(error.message || 'recovery failed').slice(0, 240);
        try { this.deviceStore.persist(); } catch {}
        throw new Error(`Matter-Ruhestellung für IDX ${idx} bleibt recovery_required; Bridge-Start abgebrochen`);
      }
    }
  }

  getOrphanRemovalStatus(idx) {
    idx = String(idx);
    const eligibility = this.deviceStore.getOrphanRemovalStatus(idx);
    if (!eligibility.eligible) return { ...eligibility, canRemove: false };
    if (!this.server || !this.aggregator) {
      return { ...eligibility, canRemove: false, reason: 'Matter-Endpunktspeicher kann derzeit nicht sicher geprüft werden.' };
    }

    const config = this.deviceStore.cfg.devices?.[idx];
    const record = this.deviceStore.records.get(idx);
    if (!config || !record
      || record.deviceId !== deviceInstanceId(idx, config)
      || record.matterEndpointId !== matterEndpointIdentity(idx, config)) {
      return { ...eligibility, canRemove: false, reason: 'Die aktuelle Gerätegeneration und ihre Matter-Identität können nicht sicher zugeordnet werden.' };
    }

    const deviceId = deviceInstanceId(idx, config);
    const endpointId = matterEndpointIdentity(idx, config);
    const activeEndpoint = this.endpoints.has(deviceId)
      || this.aggregator.parts.find((part) => part.id === endpointId) !== undefined;
    if (activeEndpoint) {
      return { ...eligibility, canRemove: false, reason: 'Ein Matter-Endpunkt mit dieser Geräteidentität ist noch aktiv.' };
    }

    try {
      const nodeStore = this.server.env.get(ServerNodeStore);
      const aggregatorStore = nodeStore.endpointStores.storeForEndpoint(this.aggregator);
      let retainedIdentity = false;
      aggregatorStore.visit((store) => {
        if (store.id === endpointId) retainedIdentity = true;
      });
      if (retirementEntriesForIdx(this.deviceStore.cfg.matterRetirements, idx)
        .some(([, retirement]) => retirement.matterEndpointId === endpointId)) retainedIdentity = true;
      if (retainedIdentity) {
        return { ...eligibility, canRemove: false, reason: 'Im Matter-Speicher ist noch eine Endpunktidentität für dieses IDX vorhanden.' };
      }
    } catch {
      return { ...eligibility, canRemove: false, reason: 'Matter-Endpunktspeicher konnte nicht sicher geprüft werden.' };
    }
    return { ...eligibility, canRemove: true, reason: null };
  }

  async removeOrphanedDevice(idx, confirmation) {
    idx = String(idx);
    return this._serializeMutation(async () => {
      if (confirmation !== idx) {
        throw Object.assign(new Error('Bestätigung stimmt nicht mit dem Domoticz-IDX überein.'), { statusCode: 400 });
      }
      if (!this.deviceStore.cfg.devices?.[idx]) {
        throw Object.assign(new Error('Gerät ist in der DomLink-Konfiguration nicht vorhanden.'), { statusCode: 404 });
      }
      const status = this.getOrphanRemovalStatus(idx);
      if (!status.canRemove) {
        const unavailable = !this.server || !this.aggregator;
        throw Object.assign(new Error(status.reason || 'Gerät kann nicht sicher aus der DomLink-Liste entfernt werden.'), { statusCode: unavailable ? 503 : 409 });
      }
      return this.deviceStore.removeOrphanedDeviceConfig(idx);
    });
  }

  async adoptRetiredDeviceAsNew(idx, confirmation) {
    idx = String(idx);
    return this._serializeMutation(async () => {
      if (confirmation !== idx) throw Object.assign(new Error('Bestätigung stimmt nicht mit dem Domoticz-IDX überein.'), { statusCode: 400 });
      const config = this.deviceStore.cfg.devices?.[idx];
      const retirement = config && retirementForDevice(this.deviceStore.cfg.matterRetirements, idx, config);
      if (!retirement || retirement.state !== 'completed') throw Object.assign(new Error('Für dieses Gerät liegt keine abgeschlossene Matter-Ruhestellung vor.'), { statusCode: 409 });
      if (!this.server || !this.aggregator) throw Object.assign(new Error('Matter-Bridge ist nicht betriebsbereit.'), { statusCode: 503 });
      const template = retirement.template || TEMPLATE_BY_ALEXA_TYPE[config.alexaType || 'SWITCH'];
      const active = this.aggregator.parts.find((part) => part.id === retirement.matterEndpointId)
        || this.endpoints.get(retirement.deviceId);
      const reservation = this._sdkStoredEndpointReservation(idx, template, retirement.matterEndpointId);
      if (active || reservation.number !== retirement.endpointNumber
        || reservation.owners.length !== 1 || reservation.owners[0] !== retirement.matterEndpointId) {
        throw Object.assign(new Error('Die frühere Matter-Identität ist nicht sicher stillgelegt; Übernahme abgebrochen.'), { statusCode: 409, recoveryRequired: true });
      }
      return this.deviceStore.adoptRetiredDeviceAsNew(idx);
    });
  }

  async retireDevice(idx, confirmation) {
    idx = String(idx);
    return this._serializeMutation(async () => {
      const cfg = this.deviceStore.cfg;
      const deviceConfig = cfg.devices?.[idx];
      const prior = deviceConfig && retirementForDevice(cfg.matterRetirements, idx, deviceConfig);
      if (confirmation !== idx) throw Object.assign(new Error('Bestätigung stimmt nicht mit dem Domoticz-IDX überein'), { statusCode: 400 });
      if (!deviceConfig) throw Object.assign(new Error('Gerät ist in der DomLink-Konfiguration nicht vorhanden'), { statusCode: 404 });
      if (prior?.state === 'completed') {
        if (deviceConfig.matterRegistered === true) {
          prior.state = 'recovery_required';
          prior.updatedAt = new Date().toISOString();
          try { this.deviceStore.persist(); } catch {}
          throw Object.assign(new Error('Matter-Ruhestellung widerspricht matterRegistered=true'), { statusCode: 409, recoveryRequired: true });
        }
        if (!this.server || !this.aggregator) throw Object.assign(new Error('Matter-Bridge ist nicht betriebsbereit; Ruhestellung kann nicht verifiziert werden'), { statusCode: 503 });
        const activeEndpoint = this.endpoints.get(prior.deviceId)
          || this.aggregator.parts.find((part) => part.id === prior.matterEndpointId);
        const record = this.deviceStore.getByDeviceId(prior.deviceId);
        const template = prior.template || record?.template;
        const reservation = template ? this._sdkStoredEndpointReservation(idx, template, prior.matterEndpointId) : { number: undefined, owners: [] };
        if (activeEndpoint || reservation.number !== prior.endpointNumber
          || reservation.owners.length !== 1 || reservation.owners[0] !== prior.matterEndpointId) {
          prior.state = 'recovery_required';
          prior.updatedAt = new Date().toISOString();
          try { this.deviceStore.persist(); } catch {}
          throw Object.assign(new Error('Matter-Ruhestellung widerspricht der tatsächlichen Endpunkttopologie'), { statusCode: 409, recoveryRequired: true });
        }
        return { ok: true, alreadyRetired: true, retirement: this._publicRetirement(prior) };
      }
      if (prior) throw Object.assign(new Error('Matter-Entfernung benötigt eine sichere Wiederherstellung beim Neustart'), { statusCode: 409, recoveryRequired: true });
      if (deviceConfig.matterRegistered !== true) throw Object.assign(new Error('Gerät ist nicht bei Matter registriert'), { statusCode: 409 });
      if (!this.server || !this.aggregator || !this.acceptCommands) throw Object.assign(new Error('Matter-Bridge ist nicht betriebsbereit'), { statusCode: 503 });
      const deviceId = deviceInstanceId(idx, deviceConfig);
      const endpoint = this.endpoints.get(deviceId);
      const matterEndpointId = matterEndpointIdentity(idx, deviceConfig);
      if (!endpoint || endpoint.id !== matterEndpointId || endpoint.owner !== this.aggregator || !Number.isInteger(endpoint.number)) {
        throw Object.assign(new Error('Matter-Endpunktzuordnung konnte nicht sicher verifiziert werden'), { statusCode: 409 });
      }
      const record = this.deviceStore.getByDeviceId(deviceId);
      if (!record || record.idx !== idx) throw Object.assign(new Error('Gespeicherte Gerätezuordnung ist inkonsistent'), { statusCode: 409 });
      const reservation = this._sdkStoredEndpointReservation(idx, record.template, endpoint.id);
      if (reservation.number !== endpoint.number || reservation.owners.length !== 1 || reservation.owners[0] !== endpoint.id) {
        throw Object.assign(new Error('Matter-Endpunktspeicher enthält eine fehlende oder kollidierende Nummernreservierung'), { statusCode: 409 });
      }
      const retirement = {
        idx, deviceId, endpointNumber: endpoint.number,
        matterEndpointId: endpoint.id,
        ...(record.instanceId ? { instanceId: record.instanceId } : {}),
        template: record.template,
        domoticzName: record.domoticzName,
        alexaName: record.alexaName,
        state: 'pending', requestedAt: new Date().toISOString(),
      };
      this.retiringDeviceIds.add(deviceId);
      this.deviceStore.retiringDevices.add(idx);
      try {
        await this._waitForEndpointCommands(deviceId);
        return await this._serializeEndpointMutation(deviceId, async () => {
          const currentEndpoint = this.endpoints.get(deviceId);
          if (currentEndpoint !== endpoint || endpoint.owner !== this.aggregator || endpoint.number !== retirement.endpointNumber) {
            throw Object.assign(new Error('Matter-Endpunkt änderte sich vor der Entfernung'), { statusCode: 409 });
          }
          cfg.matterRetirements ||= {};
          const retirementKey = retirementStorageKey(cfg.matterRetirements, retirement);
          cfg.matterRetirements[retirementKey] = retirement;
          try {
            this.deviceStore.persist();
          } catch {
            delete cfg.matterRetirements[retirementKey];
            throw Object.assign(new Error('Entfernungsabsicht konnte nicht gespeichert werden'), { statusCode: 500, recoveryRequired: false });
          }
          try {
            await endpoint.close();
            if (this.aggregator.parts.has(endpoint) || endpoint.owner !== undefined || this.endpoints.get(deviceId) !== endpoint) {
              throw new Error('Matter-Endpunkt wurde nach dem Schließen nicht sicher aus der Topologie entfernt');
            }
            this.endpoints.delete(deviceId);
            retirement.state = 'completed';
            retirement.completedAt = new Date().toISOString();
            deviceConfig.matterRegistered = false;
            record.matterRegistered = false;
            try {
              this.deviceStore.persist();
            } catch {
              retirement.state = 'recovery_required';
              retirement.updatedAt = new Date().toISOString();
              try { this.deviceStore.persist(); } catch {}
              throw new Error('Abschluss konnte nicht dauerhaft gespeichert werden');
            }
            return { ok: true, alreadyRetired: false, retirement: this._publicRetirement(retirement) };
          } catch (error) {
            retirement.state = 'recovery_required';
            retirement.error = String(error.message || 'retirement failed').slice(0, 240);
            retirement.updatedAt = new Date().toISOString();
            try { this.deviceStore.persist(); } catch {}
            throw Object.assign(new Error('Entfernung nicht abgeschlossen; Wiederherstellung erforderlich'), { statusCode: 500, recoveryRequired: true });
          }
        });
      } finally {
        this.retiringDeviceIds.delete(deviceId);
        this.deviceStore.retiringDevices.delete(idx);
      }
    });
  }

  _publicRetirement(retirement) {
    const { idx, deviceId, matterEndpointId, endpointNumber, domoticzName, alexaName, state, requestedAt, completedAt, updatedAt, instanceId } = retirement;
    return { idx, deviceId, matterEndpointId, endpointNumber, domoticzName, alexaName, state, requestedAt, completedAt, updatedAt, instanceId };
  }

  async stop() {
    return this._serializeMutation(async () => {
      this.acceptCommands = false;
      if (activeBridgeInstance === this) activeBridgeInstance = null;
      if (!this.server) return;
      await this.server.close();
      this.server = null;
      this.aggregator = null;
      this.endpoints.clear();
    });
  }

  async resetCommissioning() {
    if (!this.server) throw new Error('Matter-Bridge läuft nicht');
    await this.server.erase();
    await this.stop();
    await this.start();
  }

  getStatus() {
    if (!this.server) {
      return {
        running: false, commissioned: false, online: false, deviceCount: 0, pairingCode: null,
        initializationPending: !this.deviceStore.canRestoreRegisteredEndpoints(),
        initializationError: this.initializationError || this.deviceStore.lastInventoryError,
      };
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
      id: matterEndpointIdentity(idx, record),
      bridgedDeviceBasicInformation: {
        nodeLabel: name,
        productName: name,
        productLabel: name,
        serialNumber: matterSerialNumber(idx, record),
        reachable: record.active && record.available === true,
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
    if (this._isRetirementQuarantined(deviceId)) return;
    this.endpointCommandCounts.set(deviceId, (this.endpointCommandCounts.get(deviceId) || 0) + 1);
    try {
      await this._applyCommandLocked(deviceId, patch, commandLabel);
    } finally {
      const remaining = (this.endpointCommandCounts.get(deviceId) || 1) - 1;
      if (remaining === 0) {
        this.endpointCommandCounts.delete(deviceId);
        for (const resolve of this.endpointCommandWaiters.get(deviceId) || []) resolve();
        this.endpointCommandWaiters.delete(deviceId);
      } else {
        this.endpointCommandCounts.set(deviceId, remaining);
      }
    }
  }

  async _applyCommandLocked(deviceId, patch, commandLabel) {
    if (this._isRetirementQuarantined(deviceId)) return;
    if (!this.acceptCommands) return;
    const record = this.deviceStore.getByDeviceId(deviceId);
    const name = record ? record.alexaName || record.domoticzName : deviceId;

    eventLog.log('matter', 'info', `Alexa → ${name}: ${commandLabel}`, name);

    const isScene = String(record?.raw?.Type || this.deviceStore.cfg.devices[record?.idx]?.domoticzType || '').trim().toLowerCase() === 'scene';
    let commandFailed = false;
    try {
      await this.deviceStore.applyStateChange(deviceId, patch);
    } catch (e) {
      commandFailed = true;
      this.logger.error(`Matter: Befehl für ${deviceId} fehlgeschlagen:`, e.message);
      eventLog.log('matter', 'error', `Fehler bei ${name}: ${e.message}`, name);
    } finally {
      // Scenes are actions: return their *Matter* switch to Off after each
      // request, without turning off physical devices or firing Domoticz
      // group OffActions. A failed command should also remain retryable.
      if (isScene || commandFailed) {
        const endpoint = this.endpoints.get(deviceId);
        if (endpoint) {
          try {
            await this._pushState(endpoint, record.template, isScene ? { powerState: 'OFF' } : record.state);
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
    const deviceId = Array.from(this.endpoints.entries()).find(([id, endpoint]) =>
      endpoint.id === endpointStringId || this.deviceStore.getByDeviceId(id)?.matterEndpointId === endpointStringId)?.[0];
    if (!deviceId) return;
    this._applyCommand(deviceId, { powerState: value ? 'ON' : 'OFF' }, value ? 'Einschalten' : 'Ausschalten').catch(
      () => {}
    );
  }

  _wireCommandEvents(deviceId, template, endpoint) {
    switch (template) {
      case 'DIMMABLE_LIGHT':
        endpoint.events.levelControl.currentLevel$Changed.on((value, _oldValue, session) => {
          // @matter/main emits $Changed(newValue, oldValue, session). A local
          // Endpoint.set has no session subject; controller writes do.
          if (session?.subject === undefined || value === null || value === undefined) return;
          const pct = matterLevelToBrightness(value);
          this._applyCommand(deviceId, { brightness: pct, powerState: pct > 0 ? 'ON' : 'OFF' }, `Helligkeit ${pct}%`);
        });
        break;

      case 'WINDOW_COVERING':
        endpoint.events.windowCovering.currentPositionLiftPercent100ths$Changed.on((value, _oldValue, session) => {
          if (session?.subject === undefined || value === null || value === undefined) return;
          const pct = matterLift100thsToPercentOpen(value);
          this._applyCommand(deviceId, { percentage: pct }, `Position ${pct}%`);
        });
        break;

      case 'THERMOSTAT':
        endpoint.events.thermostat.occupiedHeatingSetpoint$Changed.on((value, _oldValue, session) => {
          if (session?.subject === undefined || value === null || value === undefined) return;
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
    await Promise.all(changes.map((change) => this._serializeEndpointMutation(change.deviceId, async () => {
        if (this._isRetirementQuarantined(change.deviceId)) return;
        const endpoint = this.endpoints.get(change.deviceId);
        if (!endpoint) return;
        const record = this.deviceStore.getByDeviceId(change.deviceId);
        const name = record ? record.alexaName || record.domoticzName : change.deviceId;
        eventLog.log('domoticz', 'info', `Domoticz → Alexa: ${name} (${describeState(change.newState)})`, name);
        await this._pushState(endpoint, change.template, change.newState);
      })));
  }

  async _setReachability(available, deviceIds = null) {
    const entries = Array.from(this.endpoints.keys()).filter((deviceId) => !deviceIds || deviceIds.includes(deviceId));
    await Promise.all(entries.map((deviceId) => this._serializeEndpointMutation(deviceId, async () => {
        if (this._isRetirementQuarantined(deviceId)) return;
        const currentEndpoint = this.endpoints.get(deviceId);
        const record = this.deviceStore.getByDeviceId(deviceId);
        if (!currentEndpoint || !record) return;
        await currentEndpoint.set({ bridgedDeviceBasicInformation: { reachable: available && record.available && record.active } });
        if (!record.available && (record.template === 'TEMPERATURE_SENSOR' || record.template === 'THERMOSTAT')) {
          await this._pushState(currentEndpoint, record.template, record.state);
        }
      })));
  }

  // Endpoints are permanent once created: toggling "Aktiv" off/on again never
  // removes and recreates the endpoint (that would let its numeric endpoint
  // number get reused for a *different* device - which is exactly what once
  // caused Alexa to associate a stale friendly name with the wrong endpoint
  // after rapid activate/deactivate cycling). Instead, deactivating just
  // flips the standard Matter "Reachable" attribute; the endpoint's identity
  // stays stable for the life of the bridge.
  async _onConfigChanged(before, after) {
    return this._serializeEndpointMutation(after.deviceId, () => this._onConfigChangedLocked(before, after));
  }

  async _onConfigChangedLocked(before, after) {
    if (!this.server) return;
    if (this._isRetirementQuarantined(after.deviceId)) return;

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
