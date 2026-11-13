import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
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

function writeConfigAtomically(configPath, config) {
  const tempPath = `${configPath}.tmp`;
  fsSync.writeFileSync(tempPath, JSON.stringify(config), 'utf8');
  fsSync.renameSync(tempPath, configPath);
}

async function readConfig(configPath) {
  return JSON.parse(await fs.readFile(configPath, 'utf8'));
}

async function createDurableRetirementFixture(tempDir, idxs = ['301', '302', '303', '304']) {
  const configPath = path.join(tempDir, 'config.json');
  let cfg = {
    matterRetirements: {},
    devices: Object.fromEntries(idxs.map((idx) => [idx, {
      active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: `Device ${idx}`, domoticzName: `Device ${idx}`,
    }])),
  };
  writeConfigAtomically(configPath, cfg);
  let writes = 0;
  const failWrites = new Set();
  const persist = () => {
    writes += 1;
    if (failWrites.delete(writes)) throw new Error('simulated config write failure');
    writeConfigAtomically(configPath, cfg);
  };
  const commands = [];
  const domoticz = {
    getDevices: async () => idxs.map((idx) => ({ idx, Name: `Device ${idx}`, Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' })),
    switchLight: async (...args) => commands.push(['switchlight', ...args]),
    switchScene: async (...args) => commands.push(['switchscene', ...args]),
    setLevel: async (...args) => commands.push(['setlevel', ...args]),
    setSetpoint: async (...args) => commands.push(['setsetpoint', ...args]),
  };
  let store;
  let bridge;
  const startFresh = async () => {
    cfg = await readConfig(configPath);
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    return bridge;
  };
  store = new DeviceStore({ cfg, persist, domoticz });
  await store.refresh();
  bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
  await bridge.start();
  return {
    configPath, domoticz, commands,
    get cfg() { return cfg; },
    get store() { return store; },
    get bridge() { return bridge; },
    setFailWrite(offset) { failWrites.add(writes + offset); },
    persist,
    async reload() { cfg = await readConfig(configPath); return cfg; },
    async restart() {
      await bridge.stop();
      return startFresh();
    },
    async startFresh() { return startFresh(); },
  };
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

test('Matter endpoint retirement closes one child, preserves its reserved number across restart, and recovers pending intent', { timeout: 60000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-matter-retirement-'));
  const configPath = path.join(tempDir, 'config.json');
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');
  let cfg = { matterRetirements: {}, devices: {
    '201': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'One', domoticzName: 'One' },
    '202': { active: false, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Two', domoticzName: 'Two' },
    '203': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Three', domoticzName: 'Three' },
  } };
  writeConfigAtomically(configPath, cfg);
  const persist = () => writeConfigAtomically(configPath, cfg);
  const commands = [];
  let inventory = [
    { idx: '201', Name: 'One', Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' },
    { idx: '203', Name: 'Three', Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' },
  ];
  const domoticz = { getDevices: async () => inventory, switchLight: async (...args) => commands.push(args) };
  let bridge;
  try {
    let store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    const original = new Map(Array.from(bridge.endpoints, ([id, ep]) => [id, ep.number]));
    const retiredNumber = original.get('domlink-202');
    assert.ok(Number.isInteger(retiredNumber));
    assert.equal(bridge.endpoints.get('domlink-202').stateOf('bridgedDeviceBasicInformation').reachable, false);
    await assert.rejects(bridge.retireDevice('202', 'wrong'), /Bestätigung stimmt/);
    const selectedEndpoint = bridge.endpoints.get('domlink-202');
    const unrelatedEndpoint = bridge.endpoints.get('domlink-201');
    const selectedSet = selectedEndpoint.set.bind(selectedEndpoint);
    const unrelatedSet = unrelatedEndpoint.set.bind(unrelatedEndpoint);
    const selectedClose = selectedEndpoint.close.bind(selectedEndpoint);
    let releaseStateMutation;
    let startedStateMutation;
    let unrelatedStateMutation;
    let closeStarted = false;
    const blocked = new Promise((resolve) => { releaseStateMutation = resolve; });
    const stateStarted = new Promise((resolve) => { startedStateMutation = resolve; });
    const unrelatedStarted = new Promise((resolve) => { unrelatedStateMutation = resolve; });
    selectedEndpoint.set = async (patch) => { startedStateMutation(); await blocked; return selectedSet(patch); };
    unrelatedEndpoint.set = async (patch) => { unrelatedStateMutation(); return unrelatedSet(patch); };
    selectedEndpoint.close = async () => { closeStarted = true; return selectedClose(); };
    const stateMutation = bridge._onDomoticzChanges([
      { deviceId: 'domlink-202', template: 'ONOFF_LIGHT', newState: { powerState: 'ON' } },
      { deviceId: 'domlink-201', template: 'ONOFF_LIGHT', newState: { powerState: 'ON' } },
    ]);
    await stateStarted;
    const retirementRequest = bridge.retireDevice('202', '202');
    await unrelatedStarted;
    assert.equal(closeStarted, false, 'endpoint close waits for its in-flight state mutation');
    releaseStateMutation();
    await stateMutation;
    const [result, concurrentResult] = await Promise.all([
      retirementRequest,
      bridge.retireDevice('202', '202'),
    ]);
    assert.equal(result.retirement.state, 'completed');
    assert.equal(concurrentResult.alreadyRetired, true);
    assert.equal(bridge.endpoints.has('domlink-202'), false);
    assert.equal(bridge.aggregator.stateOf('descriptor').partsList.includes(retiredNumber), false);
    assert.deepEqual(new Map(Array.from(bridge.endpoints, ([id, ep]) => [id, ep.number])), new Map([['domlink-201', original.get('domlink-201')], ['domlink-203', original.get('domlink-203')]]));
    assert.equal(cfg.devices['202'].matterRegistered, false);
    assert.equal((await bridge.retireDevice('202', '202')).alreadyRetired, true);
    assert.deepEqual(commands, []);

    await bridge.stop();
    cfg = await readConfig(configPath);
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    assert.equal(bridge.endpoints.has('domlink-202'), false);
    assert.equal(bridge.endpoints.get('domlink-201').number, original.get('domlink-201'));
    assert.equal(bridge.endpoints.get('domlink-203').number, original.get('domlink-203'));

    // A newly registered child must not receive the retired number.
    inventory = [...inventory, { idx: '204', Name: 'Four', Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' }];
    await store.refresh();
    store.updateDeviceConfig('204', { active: true });
    await waitFor(() => bridge.endpoints.has('domlink-204'), 'New endpoint was not registered');
    assert.notEqual(bridge.endpoints.get('domlink-204').number, retiredNumber);
    assert.equal(bridge.endpoints.get('domlink-201').number, original.get('domlink-201'));
    assert.equal(bridge.endpoints.get('domlink-203').number, original.get('domlink-203'));

    // Intent persisted before close: startup must omit only that endpoint.
    const preCloseNumber = bridge.endpoints.get('domlink-203').number;
    const newEndpointNumber = bridge.endpoints.get('domlink-204').number;
    cfg.matterRetirements['203'] = {
      idx: '203', deviceId: 'domlink-203', matterEndpointId: 'd203', endpointNumber: preCloseNumber,
      domoticzName: 'Three', alexaName: 'Three', state: 'pending', requestedAt: new Date().toISOString(),
    };
    persist();
    await bridge.stop();
    cfg = await readConfig(configPath);
    store = new DeviceStore({ cfg, persist, domoticz });
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    assert.equal(cfg.matterRetirements['203'].state, 'completed');
    assert.equal(bridge.endpoints.has('domlink-203'), false);
    assert.equal(bridge.endpoints.get('domlink-201').number, original.get('domlink-201'));
    assert.equal(bridge.endpoints.get('domlink-204').number, newEndpointNumber);

    // Simulate a process interruption after Endpoint.close() but before the
    // final config write: startup must reconcile the durable pending intent.
    cfg.devices['202'].matterRegistered = true;
    cfg.matterRetirements['202'].state = 'pending';
    persist();
    await bridge.stop();
    cfg = await readConfig(configPath);
    store = new DeviceStore({ cfg, persist, domoticz });
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    assert.equal(cfg.matterRetirements['202'].state, 'completed');
    assert.equal(cfg.devices['202'].matterRegistered, false);
    assert.equal(bridge.endpoints.has('domlink-202'), false);
    assert.deepEqual(commands, []);
  } finally {
    if (bridge?.server) await bridge.stop();
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface !== undefined) Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel !== undefined) Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('durable retirement failures and process interruptions recover only after SDK storage verification', { timeout: 60000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-matter-retirement-durable-'));
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');
  let fixture;
  try {
    fixture = await createDurableRetirementFixture(tempDir);
    const stableUnrelatedNumber = fixture.bridge.endpoints.get('domlink-304').number;

    // A failed initial atomic config write must leave the endpoint active and
    // the on-disk configuration without retirement intent.
    fixture.setFailWrite(1);
    await assert.rejects(fixture.bridge.retireDevice('301', '301'), /Entfernungsabsicht konnte nicht gespeichert werden/);
    let diskConfig = await readConfig(fixture.configPath);
    assert.equal(diskConfig.matterRetirements['301'], undefined);
    assert.equal(diskConfig.devices['301'].matterRegistered, true);
    assert.ok(fixture.bridge.endpoints.has('domlink-301'));

    // Close failure persists recovery_required. A new process may reconcile it
    // only by loading and verifying the same SDK endpoint number.
    const failedCloseEndpoint = fixture.bridge.endpoints.get('domlink-301');
    const originalClose = failedCloseEndpoint.close.bind(failedCloseEndpoint);
    failedCloseEndpoint.close = async () => { throw new Error('injected close failure'); };
    await assert.rejects(fixture.bridge.retireDevice('301', '301'), /Wiederherstellung erforderlich/);
    failedCloseEndpoint.close = originalClose;
    diskConfig = await readConfig(fixture.configPath);
    assert.equal(diskConfig.matterRetirements['301'].state, 'recovery_required');
    assert.equal(diskConfig.matterRetirements['301'].endpointNumber, failedCloseEndpoint.number);
    assert.equal(failedCloseEndpoint.stateOf('bridgedDeviceBasicInformation').reachable, true);
    await failedCloseEndpoint.set({ bridgedDeviceBasicInformation: { reachable: false } });

    let quarantinedWrites = 0;
    let unrelatedWrites = 0;
    const quarantinedSet = failedCloseEndpoint.set.bind(failedCloseEndpoint);
    const unrelatedEndpoint = fixture.bridge.endpoints.get('domlink-302');
    const unrelatedSet = unrelatedEndpoint.set.bind(unrelatedEndpoint);
    failedCloseEndpoint.set = async (...args) => { quarantinedWrites += 1; return quarantinedSet(...args); };
    unrelatedEndpoint.set = async (...args) => { unrelatedWrites += 1; return unrelatedSet(...args); };

    // The HTTP operation has returned and its temporary lock is gone, but
    // the durable recovery_required tombstone still quarantines this endpoint.
    await fixture.bridge._applyCommand('domlink-301', { powerState: 'ON' }, 'injected controller command');
    assert.deepEqual(fixture.commands, []);
    await fixture.bridge._applyCommand('domlink-302', { powerState: 'ON' }, 'unrelated controller command');
    assert.deepEqual(fixture.commands, [['switchlight', '302', 'On']]);

    await fixture.bridge._onDomoticzChanges([
      { deviceId: 'domlink-301', template: 'ONOFF_LIGHT', newState: { powerState: 'OFF' } },
      { deviceId: 'domlink-302', template: 'ONOFF_LIGHT', newState: { powerState: 'OFF' } },
    ]);
    await fixture.bridge._setReachability(true);
    const public301 = fixture.store.list().find((device) => device.idx === '301');
    await fixture.bridge._onConfigChanged(public301, { ...public301, alexaName: 'Changed during quarantine' });
    assert.equal(quarantinedWrites, 0, 'state, reachability, and config updates skip the quarantined endpoint');
    assert.ok(unrelatedWrites > 0, 'unrelated endpoints continue receiving Matter updates');
    assert.equal(failedCloseEndpoint.stateOf('bridgedDeviceBasicInformation').reachable, false);

    await fixture.restart();
    assert.equal(fixture.cfg.matterRetirements['301'].state, 'completed');
    assert.equal(fixture.bridge.endpoints.has('domlink-301'), false);
    assert.equal(fixture.bridge.endpoints.get('domlink-304').number, stableUnrelatedNumber);

    // Simulate a crash after close but before the final config write. The
    // pending record is durably written first; close changes SDK state only.
    const crashEndpoint = fixture.bridge.endpoints.get('domlink-302');
    fixture.cfg.matterRetirements['302'] = {
      idx: '302', deviceId: 'domlink-302', matterEndpointId: 'd302', endpointNumber: crashEndpoint.number,
      domoticzName: 'Device 302', alexaName: 'Device 302', state: 'pending', requestedAt: new Date().toISOString(),
    };
    fixture.persist();
    await crashEndpoint.close();
    fixture.bridge.endpoints.delete('domlink-302');
    await fixture.bridge.stop();
    await fixture.reload();
    await fixture.startFresh();
    assert.equal(fixture.cfg.matterRetirements['302'].state, 'completed');
    assert.equal(fixture.cfg.devices['302'].matterRegistered, false);
    assert.equal(fixture.bridge.endpoints.has('domlink-302'), false);
    assert.equal(fixture.bridge.endpoints.get('domlink-304').number, stableUnrelatedNumber);

    // Fail only the final completed write; recovery_required must remain on
    // disk, and the API-level call must not report success.
    fixture.setFailWrite(2);
    await assert.rejects(fixture.bridge.retireDevice('303', '303'), /Wiederherstellung erforderlich/);
    diskConfig = await readConfig(fixture.configPath);
    assert.equal(diskConfig.matterRetirements['303'].state, 'recovery_required');
    await fixture.restart();
    assert.equal(fixture.cfg.matterRetirements['303'].state, 'completed');
    assert.equal(fixture.bridge.endpoints.has('domlink-303'), false);
    assert.equal(fixture.bridge.endpoints.get('domlink-304').number, stableUnrelatedNumber);

    // A completed tombstone contradicting matterRegistered=true is downgraded
    // to recovery_required and prevents any topology from being published.
    fixture.cfg.devices['301'].matterRegistered = true;
    fixture.persist();
    await fixture.bridge.stop();
    await assert.rejects(fixture.startFresh(), /widerspricht matterRegistered=true/);
    diskConfig = await readConfig(fixture.configPath);
    assert.equal(diskConfig.matterRetirements['301'].state, 'recovery_required');
    assert.equal(fixture.bridge.endpoints.size, 0);
  } finally {
    if (fixture?.bridge?.server) await fixture.bridge.stop().catch(() => {});
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface !== undefined) Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel !== undefined) Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('startup fails closed when a tombstone has a missing or conflicting SDK endpoint reservation', { timeout: 60000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-matter-retirement-reservation-'));
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');
  let bridge;
  try {
    const configPath = path.join(tempDir, 'config.json');
    let cfg = { matterRetirements: {
      '401': { idx: '401', deviceId: 'domlink-401', matterEndpointId: 'd401', endpointNumber: 45000, state: 'completed', requestedAt: new Date().toISOString() },
    }, devices: {
      '401': { active: false, matterRegistered: false, alexaType: 'SWITCH', alexaName: 'Missing reservation', domoticzName: 'Missing reservation' },
    } };
    writeConfigAtomically(configPath, cfg);
    const persist = () => writeConfigAtomically(configPath, cfg);
    let store = new DeviceStore({ cfg, persist, domoticz: { getDevices: async () => [] } });
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await assert.rejects(bridge.start(), /Endpunktnummer .* stimmt nicht/);
    assert.equal(bridge.endpoints.size, 0);
    assert.equal((await readConfig(configPath)).matterRetirements['401'].state, 'recovery_required');

    // Seed a real SDK reservation for another endpoint, then give the
    // tombstone a conflicting expected number without touching Matter files.
    const conflictDir = path.join(tempDir, 'conflict');
    await fs.mkdir(conflictDir);
    let conflictConfig = { matterRetirements: {}, devices: {
      '402': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Seed', domoticzName: 'Seed' },
    } };
    const conflictConfigPath = path.join(conflictDir, 'config.json');
    writeConfigAtomically(conflictConfigPath, conflictConfig);
    const conflictPersist = () => writeConfigAtomically(conflictConfigPath, conflictConfig);
    store = new DeviceStore({ cfg: conflictConfig, persist: conflictPersist, domoticz: { getDevices: async () => [] } });
    bridge = new MatterBridge({ deviceStore: store, dataDir: conflictDir, logger: { log() {}, error() {} } });
    await bridge.start();
    const actualNumber = bridge.endpoints.get('domlink-402').number;
    await bridge.stop();
    conflictConfig = await readConfig(conflictConfigPath);
    conflictConfig.devices['402'].matterRegistered = false;
    conflictConfig.matterRetirements['402'] = {
      idx: '402', deviceId: 'domlink-402', matterEndpointId: 'd402', endpointNumber: actualNumber + 10,
      state: 'completed', requestedAt: new Date().toISOString(),
    };
    conflictPersist();
    store = new DeviceStore({ cfg: conflictConfig, persist: conflictPersist, domoticz: { getDevices: async () => [] } });
    bridge = new MatterBridge({ deviceStore: store, dataDir: conflictDir, logger: { log() {}, error() {} } });
    await assert.rejects(bridge.start(), /Endpunktnummer .* stimmt nicht/);
    assert.equal(bridge.endpoints.size, 0);
    assert.equal((await readConfig(conflictConfigPath)).matterRetirements['402'].state, 'recovery_required');
  } finally {
    if (bridge?.server) await bridge.stop().catch(() => {});
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface !== undefined) Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel !== undefined) Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
