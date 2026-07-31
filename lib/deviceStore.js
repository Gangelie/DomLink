const EventEmitter = require('events');
const {
  TEMPLATE_BY_ALEXA_TYPE,
  classifyDomoticzDevice,
  stateFromDomoticzDevice,
  getNumericFieldCandidates,
  DIRECTIVE_HANDLERS,
} = require('./deviceTypes');

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

class DeviceStore extends EventEmitter {
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
      const template = alexaType in TEMPLATE_BY_ALEXA_TYPE ? TEMPLATE_BY_ALEXA_TYPE[alexaType] : 'SWITCH';
      const valueField = devCfg.valueField || null;
      const freshState = stateFromDomoticzDevice(alexaType, d, valueField);

      let record = this.records.get(idx);
      if (!record) {
        record = {
          idx,
          deviceId: `vshd-${idx}`,
          domoticzName: d.Name,
          alexaName: devCfg.alexaName || d.Name,
          alexaType,
          active: devCfg.active === true,
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

  getActiveVshDevices() {
    return Array.from(this.records.values())
      .filter((r) => r.active && r.template !== null)
      .map((r) => ({
        deviceId: r.deviceId,
        friendlyName: r.alexaName || r.domoticzName,
        template: r.template,
        retrievable: true,
      }));
  }

  getByDeviceId(deviceId) {
    const idx = String(deviceId).replace(/^vshd-/, '');
    return this.records.get(idx) || null;
  }

  updateDeviceConfig(idx, patch) {
    idx = String(idx);
    const record = this.records.get(idx);
    if (!record) throw new Error('Unbekanntes Gerät');

    const devCfg = this._deviceConfig(idx);
    if (patch.active !== undefined) devCfg.active = !!patch.active;
    if (patch.alexaName !== undefined) devCfg.alexaName = String(patch.alexaName).trim() || record.domoticzName;
    if (patch.alexaType !== undefined) devCfg.alexaType = patch.alexaType;
    if (patch.valueField !== undefined) devCfg.valueField = patch.valueField || null;

    record.alexaName = devCfg.alexaName;
    record.alexaType = devCfg.alexaType;
    record.valueField = devCfg.valueField || null;
    record.template = record.alexaType in TEMPLATE_BY_ALEXA_TYPE ? TEMPLATE_BY_ALEXA_TYPE[record.alexaType] : 'SWITCH';

    // Meters have no VSH template - they can never be exposed to Alexa.
    if (record.template === null) devCfg.active = false;
    record.active = devCfg.active === true;

    record.state = stateFromDomoticzDevice(record.alexaType, record.raw, record.valueField);

    this.persist();
    this.emit('config-changed');
    return this._toPublic(record);
  }

  async applyDirective(deviceId, directiveName, payload) {
    const record = this.getByDeviceId(deviceId);
    if (!record) throw new Error(`Unbekanntes Gerät ${deviceId}`);
    if (!record.active) throw new Error(`Gerät ${deviceId} ist nicht aktiv`);

    const oldState = { ...record.state };

    if (directiveName === 'ReportState') {
      await this.refreshOne(record.idx);
      return { oldState, newState: { ...record.state }, template: record.template, deviceId: record.deviceId };
    }

    const handler = DIRECTIVE_HANDLERS[directiveName];
    if (!handler) throw new Error(`Direktive ${directiveName} wird nicht unterstützt`);

    const patch = handler(payload, record.state);
    const newState = { ...record.state, ...patch };

    await this._executeOnDomoticz(record, directiveName, newState);

    record.state = newState;
    return { oldState, newState, template: record.template, deviceId: record.deviceId };
  }

  async _executeOnDomoticz(record, directiveName, newState) {
    const { idx, template } = record;

    switch (template) {
      case 'SWITCH':
        return this.domoticz.switchLight(idx, newState.powerState === 'ON' ? 'On' : 'Off');

      case 'DIMMABLE_LIGHT_BULB':
        if (directiveName === 'SetBrightness' || directiveName === 'AdjustBrightness') {
          return this.domoticz.setLevel(idx, newState.brightness);
        }
        return this.domoticz.switchLight(idx, newState.powerState === 'ON' ? 'On' : 'Off');

      case 'BLINDS':
        if (newState.percentage >= 100) return this.domoticz.switchLight(idx, 'On');
        if (newState.percentage <= 0) return this.domoticz.switchLight(idx, 'Off');
        return this.domoticz.setLevel(idx, newState.percentage);

      case 'THERMOSTAT':
        return this.domoticz.setSetpoint(idx, newState.targetTemperature);

      default:
        return Promise.resolve();
    }
  }
}

module.exports = DeviceStore;
