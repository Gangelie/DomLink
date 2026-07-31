// Mapping between Domoticz devices, the Alexa-facing "Alexa Typ" chosen in the
// dashboard, and the VSH (Virtual Smart Home) device templates that describe
// which Alexa capabilities/properties a device exposes.

const ALEXA_TYPES = ['SWITCH', 'LIGHT', 'DIMMER', 'BLIND', 'TEMPERATURE_SENSOR', 'THERMOSTAT', 'METER'];

// VSH template used per Alexa Type. LIGHT intentionally maps to the plain
// SWITCH template (on/off only) because Domoticz on/off lights don't support
// brightness - use "DIMMER" for dimmable lamps. METER has no VSH template:
// Alexa has no generic "counter" capability, so meters/counters are shown in
// the dashboard for organization only and are never exposed to Alexa.
const TEMPLATE_BY_ALEXA_TYPE = {
  SWITCH: 'SWITCH',
  LIGHT: 'SWITCH',
  DIMMER: 'DIMMABLE_LIGHT_BULB',
  BLIND: 'BLINDS',
  TEMPERATURE_SENSOR: 'TEMPERATURE_SENSOR',
  THERMOSTAT: 'THERMOSTAT',
  METER: null,
};

const DEFAULT_STATE_BY_TEMPLATE = {
  SWITCH: { powerState: 'OFF' },
  DIMMABLE_LIGHT_BULB: { powerState: 'OFF', brightness: 100 },
  BLINDS: { percentage: 100 },
  TEMPERATURE_SENSOR: { temperature: 0, scale: 'CELSIUS' },
  THERMOSTAT: {
    temperature: 0,
    scale: 'CELSIUS',
    targetTemperature: 20,
    targetScale: 'CELSIUS',
    thermostatMode: 'AUTO',
    powerState: 'ON',
  },
};

// Alexa's Smart Home API (and VSH's template set) has no generic "power
// meter" capability - only Temperature/Contact/Motion sensors and
// controllables. Devices classified as METER can be manually reassigned to
// TEMPERATURE_SENSOR to make their reading voice-queryable (Alexa will just
// report it in "degrees"); valueField picks which raw Domoticz property
// supplies that number. Ordered roughly by usefulness.
const NUMERIC_FIELD_CANDIDATES = ['Temp', 'Usage', 'Data', 'Counter', 'CounterToday', 'Humidity', 'SetPoint'];

function parseNumericField(raw, field) {
  if (raw[field] === undefined) return null;
  const n = typeof raw[field] === 'number' ? raw[field] : parseFloat(raw[field]);
  return Number.isFinite(n) ? n : null;
}

// List raw Domoticz fields on this device that hold a usable number, with
// their current display value, so the UI can offer a "which value?" picker.
function getNumericFieldCandidates(raw) {
  const out = [];
  for (const field of NUMERIC_FIELD_CANDIDATES) {
    const value = parseNumericField(raw, field);
    if (value !== null) {
      out.push({ field, value, display: typeof raw[field] === 'string' ? raw[field] : String(raw[field]) });
    }
  }
  return out;
}

function defaultNumericField(raw) {
  for (const field of NUMERIC_FIELD_CANDIDATES) {
    if (parseNumericField(raw, field) !== null) return field;
  }
  return null;
}

// Guess a sensible Alexa Type from raw Domoticz device fields.
function classifyDomoticzDevice(d) {
  const type = (d.Type || '').toLowerCase();
  const switchType = (d.SwitchType || '').toLowerCase();
  const subType = (d.SubType || '').toLowerCase();

  // Presence of SwitchType is the reliable signal for anything switchable in
  // Domoticz - it shows up across many different Type values (Light/Switch,
  // Lighting 1/2, Color Switch, RFY blinds, ...), not just "Light/Switch".
  if (switchType) {
    if (switchType.includes('blind') || switchType.includes('venetian') || switchType.includes('shutter')) {
      return 'BLIND';
    }
    if (switchType === 'dimmer') {
      return 'DIMMER';
    }
    return 'SWITCH';
  }

  // Groups and Scenes are activatable/switchable but Domoticz doesn't give
  // them a SwitchType, so they need an explicit exception from the meter
  // fallback below.
  if (type === 'group' || type === 'scene') {
    return 'SWITCH';
  }

  if (type.includes('temp') || type === 'humidity' || subType.includes('temp')) {
    return 'TEMPERATURE_SENSOR';
  }

  if (type === 'thermostat' || type === 'setpoint' || subType.includes('setpoint') || d.SetPoint !== undefined) {
    return 'THERMOSTAT';
  }

  // No SwitchType and not a temperature/thermostat device: a passive
  // counter/meter (kWh, Voltage, Usage, P1 Smart Meter, RFXMeter, UV, Wind,
  // Lux, Air Quality, ...) rather than something switchable.
  return 'METER';
}

// Build the internal VSH-style state object from a live Domoticz device record.
// valueField optionally overrides which raw Domoticz property feeds a
// TEMPERATURE_SENSOR's reading (used to repurpose meters as voice-queryable
// "sensors" - see getNumericFieldCandidates above).
function stateFromDomoticzDevice(alexaType, d, valueField) {
  const template = TEMPLATE_BY_ALEXA_TYPE[alexaType];
  const state = { ...DEFAULT_STATE_BY_TEMPLATE[template], template };

  switch (template) {
    case 'SWITCH':
      state.powerState = d.Status === 'On' ? 'ON' : 'OFF';
      break;
    case 'DIMMABLE_LIGHT_BULB':
      state.powerState = d.Status && d.Status.startsWith('On') ? 'ON' : 'OFF';
      state.brightness = Number.isFinite(d.Level) ? d.Level : (state.powerState === 'ON' ? 100 : 0);
      break;
    case 'BLINDS':
      if (typeof d.Level === 'number' && d.Level > 0 && d.Level < 100) {
        state.percentage = d.Level;
      } else {
        state.percentage = d.Status === 'Open' || d.Status === 'On' ? 100 : 0;
      }
      break;
    case 'TEMPERATURE_SENSOR': {
      const field = valueField || defaultNumericField(d) || 'Temp';
      const value = parseNumericField(d, field);
      state.temperature = value !== null ? value : 0;
      state.scale = 'CELSIUS';
      state.sourceField = field;
      break;
    }
    case 'THERMOSTAT':
      state.temperature = typeof d.Temp === 'number' ? d.Temp : parseFloat(d.Temp) || 0;
      state.scale = 'CELSIUS';
      state.targetTemperature = typeof d.SetPoint === 'number' ? d.SetPoint : parseFloat(d.SetPoint) || 0;
      state.targetScale = 'CELSIUS';
      state.thermostatMode = 'AUTO';
      state.powerState = 'ON';
      break;
    default:
      // METER (template === null): informational only, not exposed to Alexa.
      if (d.Data !== undefined) state.value = d.Data;
      break;
  }

  return state;
}

function makeProperty(namespace, name, value, instance) {
  const prop = { namespace, name, value };
  if (instance) prop.instance = instance;
  return prop;
}

// Convert internal state -> Alexa "properties" array (used for ChangeReport / StateReport).
function buildPropertiesFromState(state) {
  const properties = [];

  if (state.powerState !== undefined) {
    properties.push(makeProperty('Alexa.PowerController', 'powerState', state.powerState));
  }
  if (state.brightness !== undefined) {
    properties.push(makeProperty('Alexa.BrightnessController', 'brightness', state.brightness));
  }
  if (state.percentage !== undefined) {
    properties.push(makeProperty('Alexa.RangeController', 'rangeValue', state.percentage, 'Blind.Lift'));
    properties.push(
      makeProperty(
        'Alexa.ModeController',
        'mode',
        state.percentage >= 100 ? 'Position.Up' : 'Position.Down',
        'Blinds.Position'
      )
    );
  }
  if (state.temperature !== undefined) {
    properties.push(
      makeProperty('Alexa.TemperatureSensor', 'temperature', { value: state.temperature, scale: state.scale || 'CELSIUS' })
    );
  }
  if (state.targetTemperature !== undefined) {
    properties.push(
      makeProperty('Alexa.ThermostatController', 'targetSetpoint', {
        value: state.targetTemperature,
        scale: state.targetScale || 'CELSIUS',
      })
    );
  }
  if (state.thermostatMode !== undefined) {
    properties.push(makeProperty('Alexa.ThermostatController', 'thermostatMode', state.thermostatMode));
  }

  return properties;
}

function annotateChanges(newProperties, oldProperties) {
  return newProperties.map((prop) => {
    const old = oldProperties.find((p) => p.namespace === prop.namespace && p.name === prop.name);
    const changed = !old || JSON.stringify(old.value) !== JSON.stringify(prop.value);
    return { ...prop, changed };
  });
}

// Directive handlers: (payload, currentState) -> partial new state
const DIRECTIVE_HANDLERS = {
  TurnOn: (_payload, currentState) => {
    const newState = { powerState: 'ON' };
    if (currentState.template === 'DIMMABLE_LIGHT_BULB') {
      newState.brightness = currentState.brightness > 0 ? currentState.brightness : 100;
    }
    return newState;
  },
  TurnOff: () => ({ powerState: 'OFF' }),
  SetBrightness: (payload) => ({
    brightness: payload.brightness,
    powerState: payload.brightness > 0 ? 'ON' : 'OFF',
  }),
  AdjustBrightness: (payload, currentState) => {
    let value = (currentState.brightness || 0) + payload.brightnessDelta;
    value = Math.max(0, Math.min(100, value));
    return { brightness: value, powerState: value > 0 ? 'ON' : 'OFF' };
  },
  SetPercentage: (payload) => ({ percentage: payload.percentage }),
  SetRangeValue: (payload) => ({ percentage: payload.rangeValue }),
  AdjustRangeValue: (payload, currentState) => {
    let value = (currentState.percentage || 0) + payload.rangeValueDelta;
    value = Math.max(0, Math.min(100, value));
    return { percentage: value };
  },
  SetTargetTemperature: (payload) => ({
    targetTemperature: payload.targetSetpoint.value,
    targetScale: payload.targetSetpoint.scale || 'CELSIUS',
    powerState: 'ON',
  }),
  AdjustTargetTemperature: (payload, currentState) => ({
    targetTemperature: (currentState.targetTemperature || 0) + payload.targetSetpointDelta.value,
    powerState: 'ON',
  }),
  ReportState: (_payload, currentState) => ({ ...currentState }),
};

module.exports = {
  ALEXA_TYPES,
  TEMPLATE_BY_ALEXA_TYPE,
  DEFAULT_STATE_BY_TEMPLATE,
  classifyDomoticzDevice,
  stateFromDomoticzDevice,
  getNumericFieldCandidates,
  buildPropertiesFromState,
  annotateChanges,
  DIRECTIVE_HANDLERS,
};
