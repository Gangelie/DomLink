// Mapping between Domoticz devices, the Alexa-facing "Alexa Typ" chosen in the
// dashboard, and the Matter device kind that determines which Matter device
// type (and clusters) the local Matter bridge exposes for it.

export const ALEXA_TYPES = ['SWITCH', 'LIGHT', 'DIMMER', 'SELECTOR', 'BLIND', 'TEMPERATURE_SENSOR', 'THERMOSTAT', 'METER'];

// Matter device kind used per Alexa Type. Matter has distinct device types for
// plugs vs. lights (unlike VSH, which only had a plain on/off "SWITCH"
// template) - LIGHT now gets its own proper OnOffLight device type. METER has
// no sane Matter device type of its own: Matter's Electrical Power/Energy
// Measurement clusters exist, but controller-side (Alexa) support for them is
// unverified, so meters stay informational-only by default (same as before).
export const TEMPLATE_BY_ALEXA_TYPE = {
  SWITCH: 'ONOFF_PLUG',
  LIGHT: 'ONOFF_LIGHT',
  DIMMER: 'DIMMABLE_LIGHT',
  SELECTOR: 'DIMMABLE_LIGHT',
  BLIND: 'WINDOW_COVERING',
  TEMPERATURE_SENSOR: 'TEMPERATURE_SENSOR',
  THERMOSTAT: 'THERMOSTAT',
  METER: null,
};

const DEFAULT_STATE_BY_TEMPLATE = {
  ONOFF_PLUG: { powerState: 'OFF' },
  ONOFF_LIGHT: { powerState: 'OFF' },
  DIMMABLE_LIGHT: { powerState: 'OFF', brightness: 100 },
  WINDOW_COVERING: { percentage: 100 },
  TEMPERATURE_SENSOR: { temperature: 0, scale: 'CELSIUS' },
  THERMOSTAT: {
    temperature: null,
    scale: 'CELSIUS',
    targetTemperature: 20,
    targetScale: 'CELSIUS',
    thermostatMode: 'AUTO',
    powerState: 'ON',
  },
};

// Alexa's Smart Home API has no generic "power meter" capability, and Matter's
// Electrical Power/Energy Measurement cluster support on the Alexa side is
// unverified. Devices classified as METER can be manually reassigned to
// TEMPERATURE_SENSOR to make their reading voice-queryable (Alexa will just
// report it in "degrees"); valueField picks which raw Domoticz property
// supplies that number. Ordered roughly by usefulness.
const NUMERIC_FIELD_CANDIDATES = ['Temp', 'Usage', 'Data', 'Counter', 'CounterToday', 'Humidity', 'SetPoint'];

function parseNumericField(raw, field) {
  if (raw[field] === undefined) return null;
  const n = typeof raw[field] === 'number' ? raw[field] : parseFloat(raw[field]);
  return Number.isFinite(n) ? n : null;
}

function parseFiniteNumericField(raw, field) {
  if (raw[field] === undefined || raw[field] === null || String(raw[field]).trim() === '') return null;
  const n = Number(raw[field]);
  return Number.isFinite(n) ? n : null;
}

// List raw Domoticz fields on this device that hold a usable number, with
// their current display value, so the UI can offer a "which value?" picker.
export function getNumericFieldCandidates(raw) {
  const out = [];
  for (const field of NUMERIC_FIELD_CANDIDATES) {
    const value = parseNumericField(raw, field);
    if (value !== null) {
      out.push({ field, value, display: typeof raw[field] === 'string' ? raw[field] : String(raw[field]) });
    }
  }
  return out;
}

// Domoticz selector levels are indexed in increments of 10. LevelNames may
// be plaintext or base64 depending on the API version/device integration.
export function isSelectorDevice(raw) {
  return String(raw?.SwitchType || '').trim().toLowerCase() === 'selector';
}

export function getSelectorLevels(raw) {
  if (!isSelectorDevice(raw)) return [];
  let names = raw?.LevelNames ?? raw?.Options?.LevelNames;
  if (typeof names !== 'string' || !names.trim()) return [];
  names = names.trim();
  if (!names.includes('|') && /^[A-Za-z0-9+/]+={0,2}$/.test(names) && names.length % 4 === 0) {
    const decoded = Buffer.from(names, 'base64').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD')) names = decoded;
  }
  return names.split('|').map((label, index) => ({
    level: index * 10,
    label: label.trim() || `${index * 10}%`,
  }));
}

export function closestSelectorLevel(raw, requested) {
  const value = Number(requested);
  if (!Number.isFinite(value)) throw new Error('Ungültiger Selector-Level');
  // Matter's LevelControl is percentage based and cannot expose values >100.
  const levels = getSelectorLevels(raw).map((item) => item.level).filter((level) => level <= 100);
  if (levels.length === 0) {
    // Some Domoticz versions omit LevelNames; snap to the standard 10% steps.
    return Math.round(Math.max(0, Math.min(100, value)) / 10) * 10;
  }
  return levels.reduce((closest, level) =>
    Math.abs(level - value) < Math.abs(closest - value) ? level : closest,
  levels[0]);
}

function selectorLevelFromDomoticz(raw) {
  for (const field of ['LevelInt', 'Level']) {
    const value = parseNumericField(raw, field);
    if (value !== null) return value;
  }
  const status = String(raw.Status || '').trim().toLowerCase();
  return getSelectorLevels(raw).find((item) => item.label.toLowerCase() === status)?.level ?? 0;
}

function defaultNumericField(raw) {
  for (const field of NUMERIC_FIELD_CANDIDATES) {
    if (parseNumericField(raw, field) !== null) return field;
  }
  return null;
}

// Guess a sensible Alexa Type from raw Domoticz device fields.
export function classifyDomoticzDevice(d) {
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
    if (switchType === 'selector') {
      return 'SELECTOR';
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

// Build the internal DomLink state object from a live Domoticz device record.
// valueField optionally overrides which raw Domoticz property feeds a
// TEMPERATURE_SENSOR's reading (used to repurpose meters as voice-queryable
// "sensors" - see getNumericFieldCandidates above).
export function stateFromDomoticzDevice(alexaType, d, valueField) {
  const template = TEMPLATE_BY_ALEXA_TYPE[alexaType];
  const state = { ...DEFAULT_STATE_BY_TEMPLATE[template], template };

  switch (template) {
    case 'ONOFF_PLUG':
    case 'ONOFF_LIGHT': {
      const kind = String(d.Type || '').trim().toLowerCase();
      // A scene is a stateless action: do not let Alexa latch it On forever.
      // Mixed groups have some active members, so report On to binary Matter.
      state.powerState = kind === 'scene' ? 'OFF'
        : d.Status === 'On' || (kind === 'group' && d.Status === 'Mixed') ? 'ON' : 'OFF';
      break;
    }
    case 'DIMMABLE_LIGHT':
      if (isSelectorDevice(d)) {
        const level = selectorLevelFromDomoticz(d);
        state.brightness = Math.max(0, Math.min(100, level));
        state.powerState = level > 0 ? 'ON' : 'OFF';
        state.selectorLabel = getSelectorLevels(d).find((item) => item.level === level)?.label || String(d.Status || '');
      } else {
        state.powerState = d.Status && d.Status.startsWith('On') ? 'ON' : 'OFF';
        const level = parseNumericField(d, 'Level');
        state.brightness = level !== null ? level : (state.powerState === 'ON' ? 100 : 0);
      }
      break;
    case 'WINDOW_COVERING':
      if (typeof d.Level === 'number' && d.Level > 0 && d.Level < 100) {
        state.percentage = d.Level;
      } else {
        state.percentage = d.Status === 'Open' || d.Status === 'On' ? 100 : 0;
      }
      break;
    case 'TEMPERATURE_SENSOR': {
      const field = valueField || defaultNumericField(d) || 'Temp';
      const value = parseNumericField(d, field);
      state.temperature = value;
      state.scale = 'CELSIUS';
      state.sourceField = field;
      break;
    }
    case 'THERMOSTAT':
      state.temperature = parseFiniteNumericField(d, 'Temp');
      state.scale = 'CELSIUS';
      // Preserve the historical SetPoint fallback; unlike measured
      // localTemperature, Matter's occupiedHeatingSetpoint cannot be null.
      state.targetTemperature = parseNumericField(d, 'SetPoint') ?? 0;
      state.targetScale = 'CELSIUS';
      state.thermostatMode = 'AUTO';
      state.powerState = 'ON';
      break;
    default:
      // METER (template === null): informational only, not exposed to Matter/Alexa.
      if (d.Data !== undefined) state.value = d.Data;
      break;
  }

  return state;
}
