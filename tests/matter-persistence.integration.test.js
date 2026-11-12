import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Environment } from '@matter/main';
import DeviceStore from '../lib/deviceStore.js';
import MatterBridge from '../lib/matterBridge.js';

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

test('v2.1.0-custom Matter storage migrates offline with stable IDs and recovers the complete topology', { timeout: 60000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-matter-persistence-'));
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  // Keep this integration server confined to loopback; it must not advertise
  // a test bridge on the user's LAN or alter MATTER_MDNS_NETWORKINTERFACE.
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');
  const cfg = { devices: {
    '101': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Scene' },
    '102': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Group' },
    '103': { active: true, matterRegistered: true, alexaType: 'THERMOSTAT', alexaName: 'Heat' },
    '104': { active: true, matterRegistered: true, alexaType: 'SELECTOR', alexaName: 'Mode' },
  } };
  const calls = [];
  let devices = null;
  const domoticz = {
    getDevices: async () => {
      if (devices === null) throw new Error('offline');
      return devices;
    },
    switchScene: async (...args) => calls.push(['switchscene', ...args]),
    switchLight: async (...args) => calls.push(['switchlight', ...args]),
    setLevel: async (...args) => calls.push(['setlevel', ...args]),
    setSetpoint: async (...args) => calls.push(['setsetpoint', ...args]),
  };
  let bridge;
  let store;
  try {
    // Seed isolated storage with the existing v2.1.0-custom endpoint shape
    // (aggregator plus stable d<idx> children), then simulate a legacy config
    // that has not yet recorded the new thermostat cache field.
    devices = [
      { idx: '101', Name: 'Scene', Type: 'Scene', Status: 'Off' },
      { idx: '102', Name: 'Group', Type: 'Group', Status: 'Mixed' },
      { idx: '103', Name: 'Heat', Type: 'Thermostat', Temp: '18.5', SetPoint: '22' },
      { idx: '104', Name: 'Mode', Type: 'Light/Switch', SwitchType: 'Selector', Status: 'Fan', LevelInt: '30', LevelNames: 'Off|Auto|Kuehlen|Fan|Heizen' },
    ];
    const legacyStore = new DeviceStore({ cfg, persist() {}, domoticz });
    await legacyStore.refresh();
    delete cfg.devices['103'].lastKnownSetPoint;
    bridge = new MatterBridge({ deviceStore: legacyStore, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    const endpointNumbers = new Map(Array.from(bridge.endpoints, ([id, endpoint]) => [id, endpoint.number]));
    assert.equal(endpointNumbers.size, 4);
    await bridge.stop();

    devices = null;
    store = new DeviceStore({ cfg, persist() {}, domoticz });
    await assert.rejects(store.refresh(), /offline/);
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    const startupFromRecovery = bridge.start();
    const startupFromPoll = bridge.start();
    assert.strictEqual(startupFromRecovery, startupFromPoll);
    await Promise.all([startupFromRecovery, startupFromPoll]);

    assert.equal(bridge.endpoints.size, 4);
    assert.deepEqual(new Map(Array.from(bridge.endpoints, ([id, endpoint]) => [id, endpoint.number])), endpointNumbers);
    assert.ok(Array.from(endpointNumbers.values()).every(Number.isInteger));
    const thermostat = bridge.endpoints.get('domlink-103');
    assert.equal(thermostat.stateOf('thermostat').occupiedHeatingSetpoint, 2000);
    assert.equal(thermostat.stateOf('bridgedDeviceBasicInformation').reachable, false);
    assert.equal(bridge.endpoints.get('domlink-102').stateOf('bridgedDeviceBasicInformation').reachable, false);

    devices = [
      { idx: '101', Name: 'Scene', Type: 'Scene', Status: 'Off' },
      { idx: '102', Name: 'Group', Type: 'Group', Status: 'Mixed' },
      { idx: '103', Name: 'Heat', Type: 'Thermostat', Temp: '18.5', SetPoint: '22' },
      { idx: '104', Name: 'Mode', Type: 'Light/Switch', SwitchType: 'Selector', Status: 'Fan', LevelInt: '30', LevelNames: 'Off|Auto|Kuehlen|Fan|Heizen' },
    ];
    await store.refresh();
    await waitFor(() => thermostat.stateOf('bridgedDeviceBasicInformation').reachable, 'Thermostat did not become reachable after recovery');
    await waitFor(() => bridge.endpoints.get('domlink-102').stateOf('bridgedDeviceBasicInformation').reachable, 'Group did not become reachable after recovery');
    await waitFor(() => thermostat.stateOf('thermostat').occupiedHeatingSetpoint === 2200, 'Thermostat did not adopt the recovered SetPoint');
    devices = devices.filter((device) => device.idx !== '102');
    await store.refresh();
    await waitFor(() => !bridge.endpoints.get('domlink-102').stateOf('bridgedDeviceBasicInformation').reachable, 'Missing Group did not become unreachable');
    assert.equal(thermostat.stateOf('bridgedDeviceBasicInformation').reachable, true);
    assert.equal(bridge.endpoints.size, 4);
    assert.equal(store.getByDeviceId('domlink-102').available, false);
    assert.equal(bridge.endpoints.get('domlink-102').stateOf('bridgedDeviceBasicInformation').reachable, false);
    assert.equal(cfg.devices['103'].lastKnownSetPoint, 22);
    assert.deepEqual(calls, []);

    const dimmerBefore = bridge.endpoints.get('domlink-104').stateOf('levelControl').currentLevel;
    const thermostatBefore = thermostat.stateOf('thermostat').occupiedHeatingSetpoint;
    store.markUnavailable(new Error('offline during operation'));
    await bridge._applyCommand('domlink-104', { brightness: 40, powerState: 'ON' }, 'test dimmer while offline');
    await bridge._applyCommand('domlink-103', { targetTemperature: 25 }, 'test thermostat while offline');
    assert.equal(bridge.endpoints.get('domlink-104').stateOf('levelControl').currentLevel, dimmerBefore);
    assert.equal(thermostat.stateOf('thermostat').occupiedHeatingSetpoint, thermostatBefore);
    assert.deepEqual(calls, []);

    await bridge.stop();
    store = new DeviceStore({ cfg, persist() {}, domoticz: { ...domoticz, getDevices: async () => { throw new Error('offline after recovery'); } } });
    await assert.rejects(store.refresh(), /offline after recovery/);
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    assert.equal(bridge.endpoints.size, endpointNumbers.size);
    assert.deepEqual(new Map(Array.from(bridge.endpoints, ([id, endpoint]) => [id, endpoint.number])), endpointNumbers);
    assert.equal(bridge.endpoints.get('domlink-103').stateOf('thermostat').occupiedHeatingSetpoint, 2200);
    assert.deepEqual(calls, []);
  } finally {
    if (bridge?.server) await bridge.stop();
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface !== undefined) Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel !== undefined) Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
