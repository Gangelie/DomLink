import { EventEmitter } from 'events';
import {
  TEMPLATE_BY_ALEXA_TYPE,
  classifyDomoticzDevice,
  stateFromDomoticzDevice,
  getNumericFieldCandidates,
} from './deviceTypes.js';
import * as eventLog from './eventLog.js';

const RELEVANT_KEYS = [
  'powerState',
  'brightness',
  'percentage',
  'temperature',
  'targetTemperature',
  'thermostatMode',
];

function stateDiffers(a, b) {
  return RELEVANT_KEYS.some((key) => a[key] !== undefined && JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

export default class DeviceStore extends EventEmitter {
  constructor({ cfg, persist, domoticz }) {
    super();
    this.cfg = cfg;
    this.persist = persist;
    this.domoticz = domoticz;
    this.records = new Map(); // idx (string) -> record
  }

  _deviceConfig(idx) {
    if (!this.cfg.devices[idx]) {
      this.cfg.devices[idx] = { active: false, alexaName: '', alexaType: 'SWITCH' };
    }
    return this.cfg.devices[idx];
  }

  async refresh() {
    const devices = await this.domoticz.getDevices();
    const changes = [];
    const seenIdx = new Set();
    let configDirty = false;

    for (const d of devices) {
      const idx = String(d.idx);
      seenIdx.add(idx);

      const isNewDevice = !this.cfg.devices[idx];
      const devCfg = this._deviceConfig(idx);

      if (isNewDevice) {
        devCfg.alexaType = classifyDomoticzDevice(d);
        devCfg.alexaName = d.Name;
        devCfg.active = false;
        configDirty = true;
      }

      const alexaType = devCfg.alexaType || 'SWITCH';
      const template = alexaType in TEMPLATE_BY_ALEXA_TYPE ? TEMPLATE_BY_ALEXA_TYPE[alexaType] : 'ONOFF_PLUG';
      const valueField = devCfg.valueField || null;
      const freshState = stateFromDomoticzDevice(alexaType, d, valueField);

      let record = this.records.get(idx);
      if (!record) {
        record = {
          idx,
          deviceId: `domlink-${idx}`,
          domoticzName: d.Name,
          alexaName: devCfg.alexaName || d.Name,
          alexaType,
          active: devCfg.active === true,
          matterRegistered: devCfg.matterRegistered === true,
          template,
          valueField,
          state: freshState,
          raw: d,
        };
        this.records.set(idx, record);
      } else {
        record.domoticzName = d.Name;
        record.alexaName = devCfg.alexaName || d.Name;
        record.alexaType = alexaType;
        record.active = devCfg.active === true;
        record.matterRegistered = devCfg.matterRegistered === true;
        record.template = template;
        record.valueField = valueField;
        record.raw = d;

        if (record.active && stateDiffers(record.state, freshState)) {
          changes.push({
            idx,
            deviceId: record.deviceId,
            template,
            oldState: record.state,
            newState: freshState,
          });
        }
        record.state = freshState;
      }
    }

    // drop devices that disappeared from Domoticz
    for (const idx of Array.from(this.records.keys())) {
      if (!seenIdx.has(idx)) {
        this.records.delete(idx);
      }
    }

    if (configDirty) {
      this.persist();
    }

    if (changes.length > 0) {
      this.emit('change', changes);
    }

    return this.list();
  }

  async refreshOne(idx) {
    idx = String(idx);
    const record = this.records.get(idx);
    if (!record) return null;
    const d = await this.domoticz.getDevice(idx);
    if (!d) return record;
    record.raw = d;
    record.state = stateFromDomoticzDevice(record.alexaType, d, record.valueField);
    return record;
  }

  _toPublic(r) {
    return {
      idx: r.idx,
      deviceId: r.deviceId,
      domoticzName: r.domoticzName,
      alexaName: r.alexaName,
      alexaType: r.alexaType,
      active: r.active,
      matterRegistered: r.matterRegistered,
      template: r.template,
      valueField: r.valueField || null,
      availableFields: getNumericFieldCandidates(r.raw || {}),
      state: r.state,
    };
  }

  list() {
    return Array.from(this.records.values())
      .map((r) => this._toPublic(r))
      .sort((a, b) => a.domoticzName.localeCompare(b.domoticzName));
  }

  // Devices that have EVER been activated at least once and therefore have
  // (or should have) a permanent Matter endpoint. Toggling "Aktiv" off later
  // never removes the endpoint again - it only flips the Matter "Reachable"
  // attribute, so a controller's (Alexa's) endpoint numbering never gets
  // reused for a different device. See matterBridge.js for why this matters.
  getRegisteredDevices() {
    return Array.from(this.records.values())
      .filter((r) => r.matterRegistered && r.template !== null)
      .map((r) => this._toPublic(r));
  }

  getByDeviceId(deviceId) {
    const idx = String(deviceId).replace(/^domlink-/, '');
    return this.records.get(idx) || null;
  }

  updateDeviceConfig(idx, patch) {
    idx = String(idx);
    const record = this.records.get(idx);
    if (!record) throw new Error('Unbekanntes Gerät');

    const before = this._toPublic(record);

    const devCfg = this._deviceConfig(idx);
    if (patch.active !== undefined) devCfg.active = !!patch.active;
    if (patch.alexaName !== undefined) devCfg.alexaName = String(patch.alexaName).trim() || record.domoticzName;
    if (patch.alexaType !== undefined) devCfg.alexaType = patch.alexaType;
    if (patch.valueField !== undefined) devCfg.valueField = patch.valueField || null;

    record.alexaName = devCfg.alexaName;
    record.alexaType = devCfg.alexaType;
    record.valueField = devCfg.valueField || null;
    record.template = record.alexaType in TEMPLATE_BY_ALEXA_TYPE ? TEMPLATE_BY_ALEXA_TYPE[record.alexaType] : 'ONOFF_PLUG';

    // Meters have no Matter device type - they can never be exposed to Alexa.
    if (record.template === null) devCfg.active = false;
    record.active = devCfg.active === true;

    // Sticky: once a device is activated for the first time it keeps its
    // Matter endpoint forever after, even when deactivated again (see
    // getRegisteredDevices() above).
    if (record.active && record.template !== null) devCfg.matterRegistered = true;
    record.matterRegistered = devCfg.matterRegistered === true;

    record.state = stateFromDomoticzDevice(record.alexaType, record.raw, record.valueField);

    this.persist();

    const after = this._toPublic(record);
    this.emit('config-changed', { idx, before, after });

    return after;
  }

  // Applies an already-resolved final state (e.g. {powerState: 'ON'},
  // {brightness: 42}, {percentage: 0}, {targetTemperature: 21}) coming from a
  // Matter cluster attribute change, and mirrors it to Domoticz.
  async applyStateChange(deviceId, patch) {
    const record = this.getByDeviceId(deviceId);
    if (!record) throw new Error(`Unbekanntes Gerät ${deviceId}`);
    if (!record.active) throw new Error(`Gerät ${deviceId} ist nicht aktiv`);

    const oldState = { ...record.state };
    const newState = { ...record.state, ...patch };

    await this._executeOnDomoticz(record, patch, newState);

    record.state = newState;
    return { oldState, newState, template: record.template, deviceId: record.deviceId };
  }

  async _executeOnDomoticz(record, patch, newState) {
    const { idx, template } = record;
    const name = record.alexaName || record.domoticzName;

    let call;
    switch (template) {
      case 'ONOFF_PLUG':
      case 'ONOFF_LIGHT': {
        const cmd = newState.powerState === 'ON' ? 'On' : 'Off';
        call = { description: `switchlight idx=${idx} → ${cmd}`, run: () => this.domoticz.switchLight(idx, cmd) };
        break;
      }

      case 'DIMMABLE_LIGHT':
        if (patch.brightness !== undefined) {
          call = {
            description: `switchlight idx=${idx} → Set Level ${newState.brightness}`,
            run: () => this.domoticz.setLevel(idx, newState.brightness),
          };
        } else {
          const cmd = newState.powerState === 'ON' ? 'On' : 'Off';
          call = { description: `switchlight idx=${idx} → ${cmd}`, run: () => this.domoticz.switchLight(idx, cmd) };
        }
        break;

      case 'WINDOW_COVERING':
        if (newState.percentage >= 100) {
          call = { description: `switchlight idx=${idx} → On (offen)`, run: () => this.domoticz.switchLight(idx, 'On') };
        } else if (newState.percentage <= 0) {
          call = { description: `switchlight idx=${idx} → Off (geschlossen)`, run: () => this.domoticz.switchLight(idx, 'Off') };
        } else {
          call = {
            description: `switchlight idx=${idx} → Set Level ${newState.percentage}`,
            run: () => this.domoticz.setLevel(idx, newState.percentage),
          };
        }
        break;

      case 'THERMOSTAT':
        call = {
          description: `setsetpoint idx=${idx} → ${newState.targetTemperature}`,
          run: () => this.domoticz.setSetpoint(idx, newState.targetTemperature),
        };
        break;

      default:
        return;
    }

    eventLog.log('domoticz', 'info', `Domoticz-Befehl: ${name} (${call.description})`, name);
    try {
      await call.run();
    } catch (err) {
      eventLog.log('domoticz', 'error', `Domoticz-Fehler bei ${name}: ${err.message}`, name);
      throw err;
    }
  }
}
