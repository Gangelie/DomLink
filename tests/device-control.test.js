import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDomoticzDevice,
  closestSelectorLevel,
  getSelectorLevels,
  stateFromDomoticzDevice,
} from '../lib/deviceTypes.js';
import DeviceStore from '../lib/deviceStore.js';
import DomoticzClient from '../lib/domoticz.js';

const LEVEL_NAMES = Buffer.from('Off|Auto|Kuehlen|Fan|Heizen', 'utf8').toString('base64');

function selector(overrides = {}) {
  return {
    idx: '323', Name: 'Klimaanlage', Type: 'Light/Switch', SwitchType: 'Selector',
    Status: 'Fan', LevelInt: '30', LevelNames: LEVEL_NAMES,
    ...overrides,
  };
}

function createStore(raw) {
  const commands = [];
  const domoticz = {
    getDevices: async () => [raw],
    switchScene: async (idx, cmd) => { commands.push(['switchscene', String(idx), cmd]); },
    switchLight: async (idx, cmd) => { commands.push(['switchlight', String(idx), cmd]); },
    setLevel: async (idx, level) => { commands.push(['setlevel', String(idx), level]); },
  };
  const store = new DeviceStore({ cfg: { devices: {} }, persist: () => {}, domoticz });
  return { store, commands };
}

test('scenes are recognized and always report Off to Matter', () => {
  const raw = { idx: '1', Name: 'Gute Nacht', Type: 'Scene', Status: 'On' };
  assert.equal(classifyDomoticzDevice(raw), 'SWITCH');
  assert.equal(stateFromDomoticzDevice('SWITCH', raw).powerState, 'OFF');
});

test('scene On uses switchscene, never switchlight; Off does not invoke a Domoticz API', async () => {
  const { store, commands } = createStore({ idx: '1', Name: 'Gute Nacht', Type: 'Scene', Status: 'On' });
  await store.refresh();
  store.updateDeviceConfig('1', { active: true });
  const result = await store.applyStateChange('domlink-1', { powerState: 'ON' });
  assert.deepEqual(commands, [['switchscene', '1', 'On']]);
  assert.equal(result.newState.powerState, 'OFF');
  await store.applyStateChange('domlink-1', { powerState: 'OFF' });
  assert.equal(commands.length, 1);
  // A subsequent On command must run the scene again even if Alexa cached On.
  await store.applyStateChange('domlink-1', { powerState: 'ON' });
  assert.deepEqual(commands, [['switchscene', '1', 'On'], ['switchscene', '1', 'On']]);
});

test('groups use switchscene for On and Off and report Mixed as On', async () => {
  const raw = { idx: '5', Name: 'Gute Nacht Gruppe', Type: 'Group', Status: 'Mixed' };
  assert.equal(stateFromDomoticzDevice('SWITCH', raw).powerState, 'ON');
  const { store, commands } = createStore(raw);
  await store.refresh();
  store.updateDeviceConfig('5', { active: true });
  await store.applyStateChange('domlink-5', { powerState: 'ON' });
  await store.applyStateChange('domlink-5', { powerState: 'OFF' });
  assert.deepEqual(commands, [['switchscene', '5', 'On'], ['switchscene', '5', 'Off']]);
});

test('ordinary devices continue using switchlight', async () => {
  const { store, commands } = createStore({ idx: '12', Name: 'Light', Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' });
  await store.refresh();
  store.updateDeviceConfig('12', { active: true });
  await store.applyStateChange('domlink-12', { powerState: 'ON' });
  assert.deepEqual(commands, [['switchlight', '12', 'On']]);
});

test('selector names, numeric status and per-level mappings are decoded', () => {
  assert.equal(classifyDomoticzDevice(selector()), 'SELECTOR');
  assert.deepEqual(getSelectorLevels(selector()).slice(3), [
    { level: 30, label: 'Fan' }, { level: 40, label: 'Heizen' },
  ]);
  assert.deepEqual(getSelectorLevels(selector({ LevelNames: 'Off|Auto|Kuehlen|Fan|Heizen' })).slice(3), [
    { level: 30, label: 'Fan' }, { level: 40, label: 'Heizen' },
  ]);
  const current = stateFromDomoticzDevice('SELECTOR', selector());
  assert.equal(current.powerState, 'ON');
  assert.equal(current.brightness, 30);
  assert.equal(current.selectorLabel, 'Fan');
  // Existing manually-configured Dimmer must still work as a Selector.
  assert.equal(stateFromDomoticzDevice('DIMMER', selector()).brightness, 30);
  assert.equal(stateFromDomoticzDevice('SELECTOR', selector({ LevelInt: undefined, Level: undefined })).brightness, 30);
});

test('selector commands snap to configured levels instead of arbitrary brightness', async () => {
  assert.equal(closestSelectorLevel(selector(), 33), 30);
  assert.equal(closestSelectorLevel(selector(), 37), 40);
  assert.equal(closestSelectorLevel(selector({ LevelNames: undefined }), 37), 40);
  const { store, commands } = createStore(selector());
  await store.refresh();
  store.updateDeviceConfig('323', { active: true });
  const result = await store.applyStateChange('domlink-323', { brightness: 37, powerState: 'ON' });
  assert.equal(result.newState.brightness, 40);
  assert.equal(result.newState.selectorLabel, 'Heizen');
  await store.applyStateChange('domlink-323', { powerState: 'OFF' });
  assert.deepEqual(commands, [['setlevel', '323', 40], ['setlevel', '323', 0]]);
});

test('Domoticz HTTP helper builds the correct switchscene API parameters', async () => {
  const client = new DomoticzClient(() => ({ url: 'http://localhost', port: '8080' }));
  client._get = async (params) => params; // Never contacts a real server.
  assert.deepEqual(await client.switchScene(5, 'Off'), {
    type: 'command', param: 'switchscene', idx: 5, switchcmd: 'Off',
  });
});

test('thermostat temperature source persists, validates and follows snapshot order', async () => {
  const thermostat = { idx: '20', Name: 'Setpoint', Type: 'Thermostat', Temp: '19.5', SetPoint: '21' };
  const sensor = { idx: '7', Name: 'Remote Temp', Type: 'Temp + Humidity', Temp: '18.25', Humidity: '45' };
  let fetched = [thermostat, sensor];
  const cfg = { devices: {} };
  const store = new DeviceStore({ cfg, persist: () => {}, domoticz: { getDevices: async () => fetched } });
  await store.refresh();
  const configured = store.updateDeviceConfig('20', { temperatureSourceIdx: '7' });
  assert.equal(cfg.devices['20'].temperatureSourceIdx, '7');
  assert.equal(configured.state.temperature, 18.25);
  assert.equal(configured.state.targetTemperature, 21);
  assert.throws(() => store.updateDeviceConfig('20', { temperatureSourceIdx: '999' }), /Temperaturquelle/);
  assert.throws(() => store.updateDeviceConfig('20', { temperatureSourceIdx: '20' }), /Temperaturquelle/);

  let latest;
  store.updateDeviceConfig('20', { active: true });
  store.on('change', (changes) => { latest = changes; });
  fetched = [sensor, thermostat];
  fetched[0] = { ...sensor, Temp: '0' };
  await store.refresh();
  assert.equal(store.getByDeviceId('domlink-20').state.temperature, 0);
  assert.equal(store.getByDeviceId('domlink-20').state.targetTemperature, 21);
  assert.equal(latest.find((change) => change.idx === '20').newState.temperature, 0);
});

test('thermostat source may be inactive, refreshOne propagates and unavailable readings stay null', async () => {
  const thermostat = { idx: '20', Name: 'Setpoint', Type: 'Thermostat', Temp: '20', SetPoint: '22' };
  let sensor = { idx: '8', Name: 'Sensor', Type: 'Temp', Temp: '17' };
  const cfg = { devices: { '20': { alexaType: 'THERMOSTAT' }, '8': { active: false } } };
  const store = new DeviceStore({ cfg, persist() {}, domoticz: {
    getDevices: async () => [sensor, thermostat],
    getDevice: async (idx) => idx === '8' ? sensor : thermostat,
  } });
  await store.refresh();
  store.updateDeviceConfig('20', { temperatureSourceIdx: 8, active: true });
  let changes;
  store.on('change', (items) => { changes = items; });
  sensor = { ...sensor, Temp: 'bad' };
  await store.refreshOne('8');
  assert.equal(store.getByDeviceId('domlink-20').state.temperature, null);
  assert.equal(store.list().find((device) => device.idx === '20').temperatureSourceIdx, '8');
  assert.equal(cfg.devices['20'].temperatureSourceIdx, '8');
  assert.deepEqual(store.list().find((device) => device.idx === '20').temperatureSources, []);
  assert.equal(changes.find((change) => change.idx === '20').newState.temperature, null);
  store.updateDeviceConfig('20', { temperatureSourceIdx: null });
  assert.equal(store.getByDeviceId('domlink-20').state.temperature, 20);
  // Legacy thermostat configurations without temperatureSourceIdx use own Temp.
  assert.equal(store.getByDeviceId('domlink-20').state.targetTemperature, 22);
});

test('missing or invalid SetPoint retains the non-null legacy fallback', () => {
  for (const setPoint of [undefined, 'invalid']) {
    const state = stateFromDomoticzDevice('THERMOSTAT', {
      idx: '22', Name: 'Thermostat', Type: 'Thermostat', Temp: 'invalid', SetPoint: setPoint,
    });
    assert.equal(state.temperature, null);
    assert.equal(state.targetTemperature, 0);
  }
  assert.equal(stateFromDomoticzDevice('THERMOSTAT', {
    idx: '22', Name: 'Thermostat', Type: 'Thermostat', Temp: '0', SetPoint: '0',
  }).targetTemperature, 0);
});
