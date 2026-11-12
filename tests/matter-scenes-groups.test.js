import test from 'node:test';
import assert from 'node:assert/strict';
import DeviceStore from '../lib/deviceStore.js';
import MatterBridge from '../lib/matterBridge.js';

function harness(raw, { switchScene } = {}) {
  const commands = [];
  const domoticz = {
    getDevices: async () => [raw],
    switchScene: async (idx, cmd) => {
      commands.push([String(idx), cmd]);
      if (switchScene) return switchScene(idx, cmd);
    },
    switchLight: async () => assert.fail('Unexpected switchlight call'),
  };
  const store = new DeviceStore({ cfg: { devices: {} }, persist: () => {}, domoticz });
  const bridge = new MatterBridge({ deviceStore: store, dataDir: '/tmp/domlink-test', logger: { error() {}, log() {} } });
  const endpointWrites = [];
  const endpoint = { set: async (patch) => endpointWrites.push(patch) };

  return { bridge, commands, domoticz, endpoint, endpointWrites, store };
}

async function activate(h, idx) {
  await h.store.refresh();
  h.store.updateDeviceConfig(idx, { active: true });
  const deviceId = `domlink-${idx}`;
  h.bridge.endpoints.set(deviceId, h.endpoint);
  // Harness endpoints stand in for a live Matter server.
  h.bridge.acceptCommands = true;

  // _handleOnOffCommand intentionally dispatches asynchronously. Capture
  // each task so tests can await the complete Domoticz + Matter state flow.
  const tasks = [];
  const apply = h.bridge._applyCommand.bind(h.bridge);
  h.bridge._applyCommand = (...args) => {
    const task = apply(...args);
    tasks.push(task);
    return task;
  };
  return {
    deviceId,
    issue: (on) => h.bridge._handleOnOffCommand(`d${idx}`, on),
    settle: async () => Promise.all(tasks.splice(0)),
  };
}

test('Matter Scene On runs one switchscene On and resets Matter OnOff without Domoticz Off', async () => {
  const h = harness({ idx: '41', Name: 'Scene', Type: 'Scene', Status: 'Off' });
  const scene = await activate(h, '41');

  scene.issue(true);
  await scene.settle();

  assert.deepEqual(h.commands, [['41', 'On']]);
  assert.deepEqual(h.endpointWrites, [{ onOff: { onOff: false } }]);
  assert.equal(h.store.getByDeviceId(scene.deviceId).state.powerState, 'OFF');
});

test('repeated Matter Scene On commands trigger the Domoticz scene each time', async () => {
  const h = harness({ idx: '42', Name: 'Scene', Type: 'Scene', Status: 'Off' });
  const scene = await activate(h, '42');

  scene.issue(true);
  await scene.settle();
  scene.issue(true);
  await scene.settle();

  assert.deepEqual(h.commands, [['42', 'On'], ['42', 'On']]);
  assert.equal(h.endpointWrites.length, 2);
  assert.ok(h.endpointWrites.every((patch) => patch.onOff.onOff === false));
});

test('failed Matter Scene command resets Matter state and remains retryable', async () => {
  let attempts = 0;
  const h = harness(
    { idx: '43', Name: 'Scene', Type: 'Scene', Status: 'Off' },
    { switchScene: async () => { if (++attempts === 1) throw new Error('mock Domoticz failure'); } },
  );
  const scene = await activate(h, '43');

  scene.issue(true);
  await scene.settle();
  assert.deepEqual(h.endpointWrites, [{ onOff: { onOff: false } }]);

  scene.issue(true);
  await scene.settle();

  assert.deepEqual(h.commands, [['43', 'On'], ['43', 'On']]);
  assert.equal(h.endpointWrites.length, 2);
  assert.ok(h.endpointWrites.every((patch) => patch.onOff.onOff === false));
});

test('offline Scene commands are blocked and the momentary Matter state stays Off', async () => {
  const h = harness({ idx: '31', Name: 'Offline Scene', Type: 'Scene', Status: 'Off' });
  const scene = await activate(h, '31');
  h.domoticz.getDevices = async () => { throw new Error('offline'); };
  await assert.rejects(h.store.refresh(), /offline/);
  scene.issue(true);
  await scene.settle();
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.endpointWrites.at(-1), { onOff: { onOff: false } });
  assert.equal(h.bridge.endpoints.get(scene.deviceId), h.endpoint);
});

test('local endpoint sync events are source-filtered without dropping concurrent controller commands', async () => {
  const domoticzCalls = [];
  const store = new DeviceStore({ cfg: { devices: {
    '51': { active: true, matterRegistered: true, alexaType: 'DIMMER', alexaName: 'Dimmer' },
    '52': { active: true, matterRegistered: true, alexaType: 'THERMOSTAT', alexaName: 'Thermostat' },
  } }, persist() {}, domoticz: {
    getDevices: async () => [
      { idx: '51', Name: 'Dimmer', Type: 'Light/Switch', SwitchType: 'Dimmer', Status: 'On', Level: 30 },
      { idx: '52', Name: 'Thermostat', Type: 'Thermostat', Temp: '19', SetPoint: '21' },
    ],
    setLevel: async (...args) => domoticzCalls.push(['setlevel', ...args]),
    setSetpoint: async (...args) => domoticzCalls.push(['setsetpoint', ...args]),
  } });
  await store.refresh();
  const bridge = new MatterBridge({ deviceStore: store, dataDir: '/tmp/domlink-test', logger: { error() {}, log() {} } });
  bridge.acceptCommands = true;

  const makeEvent = () => {
    const listeners = [];
    return { on: (listener) => listeners.push(listener), emit: (...args) => listeners.forEach((listener) => listener(...args)) };
  };
  const levelChanged = makeEvent();
  const setpointChanged = makeEvent();
  const pendingSets = [];
  const dimmerEndpoint = {
    events: { levelControl: { currentLevel$Changed: levelChanged } },
    set: (patch) => new Promise((resolve) => pendingSets.push(() => {
      levelChanged.emit(patch.levelControl.currentLevel, 76, {}); // Local Matter synchronization.
      resolve();
    })),
  };
  const thermostatEndpoint = {
    events: { thermostat: { occupiedHeatingSetpoint$Changed: setpointChanged } },
    set: (patch) => new Promise((resolve) => pendingSets.push(() => {
      setpointChanged.emit(patch.thermostat.occupiedHeatingSetpoint, 2100, {});
      resolve();
    })),
  };
  bridge.endpoints.set('domlink-51', dimmerEndpoint);
  bridge.endpoints.set('domlink-52', thermostatEndpoint);
  bridge._wireCommandEvents('domlink-51', 'DIMMABLE_LIGHT', dimmerEndpoint);
  bridge._wireCommandEvents('domlink-52', 'THERMOSTAT', thermostatEndpoint);

  const tasks = [];
  const apply = bridge._applyCommand.bind(bridge);
  bridge._applyCommand = (...args) => { const task = apply(...args); tasks.push(task); return task; };

  // Two overlapping local updates on one endpoint and another endpoint must
  // not mask remote controller writes arriving before those updates resolve.
  const syncPromises = [
    bridge._pushState(dimmerEndpoint, 'DIMMABLE_LIGHT', { powerState: 'ON', brightness: 30 }),
    bridge._pushState(dimmerEndpoint, 'DIMMABLE_LIGHT', { powerState: 'ON', brightness: 35 }),
    bridge._pushState(thermostatEndpoint, 'THERMOSTAT', { temperature: 19, targetTemperature: 21 }),
  ];
  levelChanged.emit(127, 76, { subject: { fabric: 1 } });
  setpointChanged.emit(2250, 2100, { subject: { fabric: 1 } });
  await Promise.all(tasks.splice(0));
  pendingSets.reverse().forEach((finish) => finish());
  await Promise.all(syncPromises);

  assert.deepEqual(domoticzCalls, [
    ['setlevel', '51', 50],
    ['setsetpoint', '52', 22.5],
  ]);
});

test('Matter Group sends On and Off and does not receive an automatic state reset', async () => {
  const h = harness({ idx: '44', Name: 'Group', Type: 'Group', Status: 'Off' });
  const group = await activate(h, '44');

  group.issue(true);
  await group.settle();
  group.issue(false);
  await group.settle();

  assert.deepEqual(h.commands, [['44', 'On'], ['44', 'Off']]);
  assert.deepEqual(h.endpointWrites, []);
  assert.equal(h.store.getByDeviceId(group.deviceId).state.powerState, 'OFF');
});

test('thermostat sensor updates push measured value only and never write SetPoint', async () => {
  const thermostat = { idx: '60', Name: 'Thermostat', Type: 'Thermostat', Temp: '19.75', SetPoint: '21' };
  const sensor = { idx: '61', Name: 'External', Type: 'Temp', Temp: '18.25' };
  const commands = [];
  const store = new DeviceStore({ cfg: { devices: {} }, persist() {}, domoticz: {
    getDevices: async () => [sensor, thermostat],
    setSetpoint: async (...args) => commands.push(args),
  } });
  const bridge = new MatterBridge({ deviceStore: store, dataDir: '/tmp/domlink-test', logger: { error() {}, log() {} } });
  assert.deepEqual(bridge._stateToClusterPatch('THERMOSTAT', { temperature: 18.25, targetTemperature: 21 }).thermostat, {
    localTemperature: 1825, occupiedHeatingSetpoint: 2100, systemMode: 4, controlSequenceOfOperation: 2,
  });
  assert.equal(bridge._stateToClusterPatch('THERMOSTAT', { temperature: null, targetTemperature: 21 }).thermostat.localTemperature, null);
  assert.equal(bridge._stateToClusterPatch('THERMOSTAT', { temperature: 0, targetTemperature: 21 }).thermostat.localTemperature, 0);
  await store.refresh();
  store.updateDeviceConfig('60', { active: true, temperatureSourceIdx: '61' });
  const endpointWrites = [];
  bridge.endpoints.set('domlink-60', { set: async (patch) => endpointWrites.push(patch) });
  // Run the mocked endpoint through the same store change path without the
  // constructor's fire-and-forget listener, so assertions are deterministic.
  store.removeAllListeners('change');
  const prior = { ...store.getByDeviceId('domlink-60').state };
  sensor.Temp = '18.5';
  await store.refresh();
  assert.equal(store.getByDeviceId('domlink-60').state.temperature, 18.5);
  await bridge._onDomoticzChanges([{
    idx: '60', deviceId: 'domlink-60', template: 'THERMOSTAT', oldState: prior,
    newState: store.getByDeviceId('domlink-60').state,
  }]);
  assert.equal(endpointWrites[0].thermostat.localTemperature, 1850);
  assert.equal(endpointWrites[0].thermostat.occupiedHeatingSetpoint, 2100);

  const unavailableState = { ...store.getByDeviceId('domlink-60').state, temperature: null };
  await bridge._onDomoticzChanges([{ deviceId: 'domlink-60', template: 'THERMOSTAT', newState: unavailableState }]);
  const zeroState = { ...unavailableState, temperature: 0 };
  await bridge._onDomoticzChanges([{ deviceId: 'domlink-60', template: 'THERMOSTAT', newState: zeroState }]);
  assert.deepEqual(endpointWrites.slice(1).map((write) => write.thermostat.localTemperature), [null, 0]);
  assert.ok(endpointWrites.every((write) => write.thermostat.occupiedHeatingSetpoint === 2100));
  assert.deepEqual(commands, []);
});

test('Matter Group reports Domoticz Mixed status as On', async () => {
  const h = harness({ idx: '45', Name: 'Group', Type: 'Group', Status: 'Mixed' });
  const group = await activate(h, '45');

  assert.equal(h.store.getByDeviceId(group.deviceId).state.powerState, 'ON');
  await h.bridge._pushState(h.endpoint, 'ONOFF_PLUG', h.store.getByDeviceId(group.deviceId).state);
  assert.deepEqual(h.endpointWrites, [{ onOff: { onOff: true } }]);
});

test('rapid repeated Scene On commands each execute and leave Matter Off despite reverse completion', async () => {
  const gates = [];
  const h = harness(
    { idx: '46', Name: 'Scene', Type: 'Scene', Status: 'Off' },
    { switchScene: () => new Promise((resolve) => gates.push(resolve)) },
  );
  const scene = await activate(h, '46');

  scene.issue(true);
  scene.issue(true);
  assert.deepEqual(h.commands, [['46', 'On'], ['46', 'On']]);

  // Resolve the later request first to exercise overlapping completion paths.
  gates[1]();
  await new Promise((resolve) => setImmediate(resolve));
  gates[0]();
  await scene.settle();

  assert.equal(h.endpointWrites.length, 2);
  assert.ok(h.endpointWrites.every((patch) => patch.onOff.onOff === false));
  assert.equal(h.store.getByDeviceId(scene.deviceId).state.powerState, 'OFF');
});

test('rapid Group On and Off commands both reach Domoticz without scene-style resets', async () => {
  const gates = [];
  const h = harness(
    { idx: '47', Name: 'Group', Type: 'Group', Status: 'Off' },
    { switchScene: () => new Promise((resolve) => gates.push(resolve)) },
  );
  const group = await activate(h, '47');

  group.issue(true);
  group.issue(false);
  assert.deepEqual(h.commands, [['47', 'On'], ['47', 'Off']]);

  gates[1]();
  await new Promise((resolve) => setImmediate(resolve));
  gates[0]();
  await group.settle();

  assert.deepEqual(h.endpointWrites, []);
});
