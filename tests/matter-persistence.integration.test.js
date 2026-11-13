import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { Environment } from '@matter/main';
import { ServerNodeStore } from '../node_modules/@matter/node/dist/esm/storage/server/ServerNodeStore.js';
import DeviceStore from '../lib/deviceStore.js';
import MatterBridge from '../lib/matterBridge.js';
import { createDeviceApiRouter } from '../lib/deviceApi.js';
import { createDomoticzStatus, recordValidDomoticzInventory } from '../lib/domoticzStatus.js';
import { createAuthRouter, requireAuth } from '../lib/auth.js';

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
    const serialNumbers = new Map(Array.from(bridge.endpoints, ([id, endpoint]) => [id, endpoint.stateOf('bridgedDeviceBasicInformation').serialNumber]));
    assert.equal(endpointNumbers.size, 4);
    assert.equal(serialNumbers.get('domlink-101'), 'domlink-101', 'legacy Matter serial number stays unchanged');
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
    assert.deepEqual(new Map(Array.from(bridge.endpoints, ([id, endpoint]) => [id, endpoint.stateOf('bridgedDeviceBasicInformation').serialNumber])), serialNumbers, 'legacy serial numbers survive restart');
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

test('retired IDX archives after valid absence and safely returns as a new Matter generation', { timeout: 60000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-retired-idx-reuse-'));
  const configPath = path.join(tempDir, 'config.json');
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');
  let inventory = ['323', '324'];
  let failInventory = false;
  let failPersist = false;
  let currentName = 'Old device';
  const commands = [];
  let cfg = { matterRetirements: {}, deviceLifecycles: {}, devices: {
    '323': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Old Alexa name', domoticzName: 'Old device' },
    '324': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Unrelated', domoticzName: 'Unrelated' },
  } };
  writeConfigAtomically(configPath, cfg);
  const persist = () => {
    if (failPersist) { failPersist = false; throw new Error('simulated lifecycle persistence failure'); }
    writeConfigAtomically(configPath, cfg);
  };
  const domoticz = {
    getDevices: async () => {
      if (failInventory) throw new Error('temporary Domoticz outage');
      return inventory.map((idx) => ({ idx, Name: idx === '323' ? currentName : 'Unrelated', Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' }));
    },
    switchLight: async (...args) => commands.push(args),
  };
  let store;
  let bridge;
  const reopen = async () => {
    cfg = await readConfig(configPath);
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
  };
  try {
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    const oldId = bridge.endpoints.get('domlink-323').id;
    const oldNumber = bridge.endpoints.get('domlink-323').number;
    const unrelatedNumber = bridge.endpoints.get('domlink-324').number;
    await bridge.retireDevice('323', '323');
    const tombstone = cfg.matterRetirements['323'];
    assert.equal(tombstone.matterEndpointId, oldId);
    assert.equal(tombstone.endpointNumber, oldNumber);
    const retiredWhilePresent = store.list().find((device) => device.idx === '323');
    assert.equal(retiredWhilePresent.retired, true);
    assert.equal(retiredWhilePresent.active, false, 'retired present device must not show an enabled toggle');
    assert.equal(retiredWhilePresent.archived, false, 'present retired device remains in the current list');

    currentName = 'Renamed old device';
    await store.refresh();
    assert.equal(cfg.devices['323'].instanceId, undefined, 'renaming a retired device does not imply IDX reuse');
    assert.equal(store.records.get('323').matterEndpointId, oldId, 'renaming cannot replace the old Matter identity');

    inventory = ['324'];
    await store.refresh();
    assert.equal(cfg.deviceLifecycles['323'].present, false);
    assert.equal(store.list().some((device) => device.idx === '323'), false, 'confirmed absent completed retirement leaves the current device list');
    assert.equal(store.listRetiredArchive().length, 1);
    const historyBeforeRestart = structuredClone(cfg.matterRetirements);
    await bridge.stop();
    await reopen();
    assert.deepEqual(cfg.matterRetirements, historyBeforeRestart, 'tombstone and archive survive restart');
    assert.equal(store.list().some((device) => device.idx === '323'), false);
    assert.equal(store.listRetiredArchive()[0].matterEndpointId, oldId);
    assert.equal(bridge.endpoints.has('domlink-323'), false);
    assert.equal(bridge.endpoints.get('domlink-324').number, unrelatedNumber);

    failInventory = true;
    const lifecycleBeforeFailure = structuredClone(cfg.deviceLifecycles);
    await assert.rejects(store.refresh(), /temporary Domoticz outage/);
    assert.deepEqual(cfg.deviceLifecycles, lifecycleBeforeFailure, 'failed inventory cannot alter lifecycle or archive classification');
    failInventory = false;

    inventory = ['323', '324'];
    currentName = 'Replacement device';
    failPersist = true;
    await assert.rejects(store.refresh(), /simulated lifecycle persistence failure/);
    assert.equal(cfg.devices['323'].instanceId, undefined, 'failed identity migration restores the old config in memory');
    assert.equal(cfg.matterRetirements['323'].supersededAt, undefined, 'failed migration leaves history unchanged');
    assert.equal(bridge.endpoints.has(tombstone.deviceId), false, 'failed migration does not recreate the retired child');

    await store.refresh();
    const replacementConfig = cfg.devices['323'];
    const replacementRecord = store.records.get('323');
    assert.equal(replacementConfig.active, false);
    assert.equal(replacementConfig.matterRegistered, false);
    assert.equal(replacementConfig.alexaName, 'Replacement device');
    assert.notEqual(replacementRecord.deviceId, tombstone.deviceId);
    assert.notEqual(replacementRecord.matterEndpointId, oldId);
    assert.equal(bridge.endpoints.has(tombstone.deviceId), false, 'retired child is never recreated');
    assert.equal(bridge.endpoints.get('domlink-324').number, unrelatedNumber);
    assert.equal(store.listRetiredArchive().length, 1, 'historical retirement remains archived after IDX reuse');
    assert.equal(bridge._isRetirementQuarantined(replacementRecord.deviceId), false, 'previous generation tombstone cannot quarantine replacement');

    store.updateDeviceConfig('323', { active: true, alexaName: 'New Alexa device' });
    await bridge.mutationQueue;
    await waitFor(() => bridge.endpoints.has(replacementRecord.deviceId), 'replacement endpoint did not register');
    const newEndpoint = bridge.endpoints.get(replacementRecord.deviceId);
    assert.notEqual(newEndpoint.id, oldId);
    assert.notEqual(newEndpoint.number, oldNumber);
    assert.equal(newEndpoint.number !== unrelatedNumber, true);
    const newSerialNumber = newEndpoint.stateOf('bridgedDeviceBasicInformation').serialNumber;
    assert.notEqual(newSerialNumber, `domlink-323`);
    assert.ok(newSerialNumber.length <= 32);
    bridge._handleOnOffCommand(oldId, true);
    assert.deepEqual(commands, [], 'a command addressed to the retired child cannot route to the replacement');
    bridge._handleOnOffCommand(newEndpoint.id, true);
    await waitFor(() => commands.length === 1, 'current generation command was not routed');
    assert.deepEqual(commands, [['323', 'On']]);
    assert.equal(bridge.endpoints.has(tombstone.deviceId), false);
    const newDeviceId = replacementRecord.deviceId;
    const newNumber = newEndpoint.number;
    await bridge.stop();
    await reopen();
    assert.equal(bridge.endpoints.get(newDeviceId).id, replacementConfig.matterEndpointId);
    assert.equal(bridge.endpoints.get(newDeviceId).number, newNumber);
    assert.equal(bridge.endpoints.get(newDeviceId).stateOf('bridgedDeviceBasicInformation').serialNumber, newSerialNumber);
    assert.equal(bridge.endpoints.has(tombstone.deviceId), false);
    assert.equal(bridge.endpoints.get('domlink-324').number, unrelatedNumber);
    assert.equal(cfg.matterRetirements['323'].matterEndpointId, oldId);
    assert.equal(cfg.matterRetirements['323'].endpointNumber, oldNumber);

    await bridge.retireDevice('323', '323');
    const secondTombstoneKey = `323@${replacementConfig.instanceId}`;
    const secondTombstone = cfg.matterRetirements[secondTombstoneKey];
    assert.ok(secondTombstone);
    assert.notEqual(secondTombstone.matterEndpointId, oldId);
    assert.notEqual(secondTombstone.endpointNumber, oldNumber);
    inventory = ['324'];
    await store.refresh();
    await bridge.stop();
    await reopen();
    assert.equal(bridge.endpoints.has(tombstone.deviceId), false);
    assert.equal(bridge.endpoints.has(secondTombstone.deviceId), false);
    assert.equal(bridge.endpoints.get('domlink-324').number, unrelatedNumber);
    for (const retired of [tombstone, secondTombstone]) {
      const reservation = bridge._sdkStoredEndpointReservation('323', retired.template, retired.matterEndpointId);
      assert.equal(reservation.number, retired.endpointNumber);
      assert.deepEqual(reservation.owners, [retired.matterEndpointId]);
    }

    inventory = ['323', '324'];
    currentName = 'Third device';
    await store.refresh();
    const thirdRecord = store.records.get('323');
    assert.equal(cfg.devices['323'].active, false);
    assert.equal(cfg.devices['323'].matterRegistered, false);
    assert.notEqual(thirdRecord.matterEndpointId, oldId);
    assert.notEqual(thirdRecord.matterEndpointId, secondTombstone.matterEndpointId);
    store.updateDeviceConfig('323', { active: true });
    await bridge.mutationQueue;
    await waitFor(() => bridge.endpoints.has(thirdRecord.deviceId), 'third generation endpoint did not register');
    const thirdEndpoint = bridge.endpoints.get(thirdRecord.deviceId);
    assert.notEqual(thirdEndpoint.number, oldNumber);
    assert.notEqual(thirdEndpoint.number, secondTombstone.endpointNumber);
    assert.notEqual(thirdEndpoint.stateOf('bridgedDeviceBasicInformation').serialNumber, newSerialNumber);
    const thirdId = thirdEndpoint.id;
    const thirdNumber = thirdEndpoint.number;
    await bridge.stop();
    await reopen();
    assert.equal(bridge.endpoints.get(thirdRecord.deviceId).id, thirdId);
    assert.equal(bridge.endpoints.get(thirdRecord.deviceId).number, thirdNumber);
    assert.equal(bridge.endpoints.has(tombstone.deviceId), false);
    assert.equal(bridge.endpoints.has(secondTombstone.deviceId), false);
    assert.equal(bridge.endpoints.get('domlink-324').number, unrelatedNumber);
  } finally {
    if (bridge?.server) await bridge.stop().catch(() => {});
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface !== undefined) Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel !== undefined) Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('adopt-new API is authenticated, exact-confirmed and rolls back persistence failures', { timeout: 60000 }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-adopt-new-api-'));
  const configPath = path.join(tempDir, 'config.json');
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');
  let inventory = ['323', '324', '325'];
  let failPersist = false;
  const cfg = { matterRetirements: {}, deviceLifecycles: {}, devices: {
    '323': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Old', domoticzName: 'Old' },
    '324': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Other', domoticzName: 'Other' },
    '325': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Absent later', domoticzName: 'Absent later' },
  } };
  writeConfigAtomically(configPath, cfg);
  const persist = () => {
    if (failPersist) { failPersist = false; throw new Error('simulated adoption persistence failure'); }
    writeConfigAtomically(configPath, cfg);
  };
  const domoticz = {
    getDevices: async () => inventory.map((idx) => ({ idx, Name: idx === '323' ? 'Current device' : 'Other', Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' })),
    switchLight: async () => {},
  };
  let store;
  let bridge;
  let apiServer;
  try {
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    const oldEndpoint = bridge.endpoints.get('domlink-323');
    const oldId = oldEndpoint.id;
    const oldNumber = oldEndpoint.number;
    await bridge.retireDevice('323', '323');
    const retirement = cfg.matterRetirements['323'];
    const otherNumber = bridge.endpoints.get('domlink-324').number;

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: false }));
    const authConfig = { passwordHash: bcrypt.hashSync('test-password', 4), mustChangePassword: false };
    app.use('/api/auth', createAuthRouter(authConfig, () => {}));
    app.use('/api', requireAuth);
    app.use('/api', createDeviceApiRouter({ deviceStore: store, matter: bridge }));
    apiServer = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${apiServer.address().port}`;
    const endpoint = `${base}/api/devices/323/adopt-new`;
    const post = (confirmIdx, cookie) => fetch(endpoint, {
      method: 'POST', headers: { ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmIdx }),
    });
    assert.equal((await post('323')).status, 401, 'unauthenticated adoption is rejected');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await post('999', cookie)).status, 400, 'confirmation must exactly match the path IDX');

    // Completed retirement is insufficient when the IDX is absent.
    await bridge.retireDevice('325', '325');
    const absentRetirement = cfg.matterRetirements['325'];
    inventory = ['323', '324'];
    await store.refresh();
    const absentEndpoint = `${base}/api/devices/325/adopt-new`;
    const postAbsent = (confirmIdx) => fetch(absentEndpoint, {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmIdx }),
    });
    assert.equal((await postAbsent('325')).status, 409);
    assert.equal(cfg.matterRetirements['325'].matterEndpointId, absentRetirement.matterEndpointId);
    inventory = ['323', '324', '325'];
    await store.refresh();

    for (const state of ['pending', 'recovery_required']) {
      retirement.state = state;
      persist();
      assert.equal((await post('323', cookie)).status, 409, `${state} retirement cannot be adopted`);
    }
    retirement.state = 'completed';
    persist();

    const verifyReservation = bridge._sdkStoredEndpointReservation.bind(bridge);
    bridge._sdkStoredEndpointReservation = (...args) => args.at(-1) === oldId
      ? { number: oldNumber, owners: ['conflicting-owner'] }
      : verifyReservation(...args);
    assert.equal((await post('323', cookie)).status, 409, 'adoption fails closed on an unverified old reservation');
    bridge._sdkStoredEndpointReservation = verifyReservation;

    const identitySnapshot = () => {
      const storeForChildren = bridge.server.env.get(ServerNodeStore).endpointStores.storeForEndpoint(bridge.aggregator);
      const saved = [];
      storeForChildren.visit((item) => saved.push([item.id, item.number]));
      return saved.sort(([a], [b]) => a.localeCompare(b));
    };
    const identitiesBeforeFailure = identitySnapshot();
    const configBeforeFailure = structuredClone(cfg);
    const endpointsBeforeAdoption = new Map(Array.from(bridge.endpoints, ([id, item]) => [id, [item.id, item.number]]));
    failPersist = true;
    const failedAdoption = await post('323', cookie);
    assert.equal(failedAdoption.status, 500, await failedAdoption.text());
    assert.deepEqual(cfg, configBeforeFailure, 'failed persistence restores current config and retirement history');
    assert.deepEqual(identitySnapshot(), identitiesBeforeFailure, 'adoption never changes Matter storage');
    assert.equal(bridge.endpoints.get('domlink-324').number, otherNumber);

    const adoptedResponse = await post('323', cookie);
    assert.equal(adoptedResponse.status, 200);
    const adopted = await adoptedResponse.json();
    assert.equal(adopted.device.active, false);
    assert.equal(adopted.device.matterRegistered, false);
    assert.notEqual(adopted.device.matterEndpointId, oldId);
    assert.equal(cfg.matterRetirements['323'].matterEndpointId, oldId);
    assert.equal(bridge.endpoints.has('domlink-323'), false);
    assert.equal(bridge.endpoints.get('domlink-324').number, otherNumber);
    assert.deepEqual(cfg.matterRetirements['325'], configBeforeFailure.matterRetirements['325'], 'adoption preserves unrelated retirement history');
    assert.deepEqual(cfg.devices['324'], configBeforeFailure.devices['324'], 'adoption preserves unrelated device configuration');
    assert.deepEqual(new Map(Array.from(bridge.endpoints, ([id, item]) => [id, [item.id, item.number]])), endpointsBeforeAdoption, 'adoption does not alter any live endpoint');
    const replacement = store.records.get('323');
    store.updateDeviceConfig('323', { active: true });
    await bridge.mutationQueue;
    await waitFor(() => bridge.endpoints.has(replacement.deviceId), 'manually adopted generation did not register');
    assert.notEqual(bridge.endpoints.get(replacement.deviceId).number, oldNumber);
  } finally {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    if (bridge?.server) await bridge.stop().catch(() => {});
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface !== undefined) Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel !== undefined) Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('IDX reuse after orphan cleanup keeps historical Matter identities reserved', { timeout: 60000 }, async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-reuse-after-orphan-'));
  const configPath = path.join(tempDir, 'config.json');
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');
  let inventory = ['323', '324'];
  let cfg = { matterRetirements: {}, deviceLifecycles: {}, devices: {
    '323': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'First', domoticzName: 'First' },
    '324': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Other', domoticzName: 'Other' },
  } };
  writeConfigAtomically(configPath, cfg);
  const persist = () => writeConfigAtomically(configPath, cfg);
  const domoticz = { getDevices: async () => inventory.map((idx) => ({ idx, Name: idx === '323' ? 'Current IDX 323' : 'Other', Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' })), switchLight: async () => {} };
  let store;
  let bridge;
  const restart = async () => {
    cfg = await readConfig(configPath);
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
  };
  try {
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    bridge = new MatterBridge({ deviceStore: store, dataDir: tempDir, logger: { log() {}, error() {} } });
    await bridge.start();
    const firstDeviceId = store.records.get('323').deviceId;
    const firstId = bridge.endpoints.get(firstDeviceId).id;
    const firstNumber = bridge.endpoints.get(firstDeviceId).number;
    const otherNumber = bridge.endpoints.get('domlink-324').number;
    await bridge.retireDevice('323', '323');
    const firstTombstone = cfg.matterRetirements['323'];

    inventory = ['324'];
    await store.refresh();
    inventory = ['323', '324'];
    await store.refresh();
    const secondGeneration = store.records.get('323');
    assert.notEqual(secondGeneration.matterEndpointId, firstId);
    assert.equal(secondGeneration.active, false);
    assert.equal(secondGeneration.matterRegistered, false);
    assert.equal(bridge.endpoints.has(secondGeneration.deviceId), false, 'replacement discovery does not auto-register');

    inventory = ['324'];
    await store.refresh();
    assert.equal(bridge.getOrphanRemovalStatus('323').canRemove, true, 'current unregistered generation is removable despite the old d323 tombstone');
    const savedIdsBefore = [];
    bridge.server.env.get(ServerNodeStore).endpointStores.storeForEndpoint(bridge.aggregator).visit((saved) => savedIdsBefore.push([saved.id, saved.number]));
    await bridge.removeOrphanedDevice('323', '323');
    assert.equal(cfg.matterRetirements['323'].matterEndpointId, firstId, 'orphan cleanup preserves the historical tombstone');
    const savedIdsAfter = [];
    bridge.server.env.get(ServerNodeStore).endpointStores.storeForEndpoint(bridge.aggregator).visit((saved) => savedIdsAfter.push([saved.id, saved.number]));
    assert.deepEqual(savedIdsAfter, savedIdsBefore, 'orphan cleanup does not change Matter storage');

    inventory = ['323', '324'];
    await store.refresh();
    const thirdGeneration = store.records.get('323');
    assert.equal(thirdGeneration.active, false);
    assert.equal(thirdGeneration.matterRegistered, false);
    assert.notEqual(thirdGeneration.matterEndpointId, firstId, 'new discovery cannot fall back to the retired d323 identity');
    assert.notEqual(thirdGeneration.matterEndpointId, secondGeneration.matterEndpointId);
    assert.equal(bridge.endpoints.has(thirdGeneration.deviceId), false, 'third generation remains unregistered');
    await bridge.stop();
    await restart();
    assert.equal(store.records.get('323').matterEndpointId, thirdGeneration.matterEndpointId);
    assert.equal(bridge.endpoints.has(thirdGeneration.deviceId), false);
    assert.equal(bridge.endpoints.get('domlink-324').number, otherNumber);
    const oldReservation = bridge._sdkStoredEndpointReservation('323', firstTombstone.template, firstId);
    assert.equal(oldReservation.number, firstNumber);
    assert.deepEqual(oldReservation.owners, [firstId]);
  } finally {
    if (bridge?.server) await bridge.stop().catch(() => {});
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface !== undefined) Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel !== undefined) Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('orphan cleanup removes only a confirmed never-registered entry and preserves Matter identities', { timeout: 60000 }, async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'domlink-orphan-cleanup-'));
  const configPath = path.join(tempDir, 'config.json');
  const previousPort = process.env.MATTER_PORT;
  const previousMdnsInterface = Environment.default.vars.get('mdns.networkInterface');
  const previousLogLevel = Environment.default.vars.get('log.level');
  process.env.MATTER_PORT = String(await unusedPort());
  Environment.default.vars.set('mdns.networkInterface', 'lo');
  Environment.default.vars.set('log.level', 'error');

  let inventory = ['321', '322', '324', '326', '330'];
  let cfg = {
    matterRetirements: {},
    devices: {
      '321': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Unrelated one', domoticzName: 'Unrelated one' },
      '322': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Unrelated two', domoticzName: 'Unrelated two' },
      '323': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Retired', domoticzName: 'Retired' },
      '325': { active: false, matterRegistered: false, alexaType: 'SWITCH', alexaName: 'Referenced', domoticzName: 'Referenced' },
      '326': { active: false, matterRegistered: false, alexaType: 'SWITCH', alexaName: 'Still present', domoticzName: 'Still present' },
      '327': { active: true, matterRegistered: false, alexaType: 'SWITCH', alexaName: 'Unexpected active', domoticzName: 'Unexpected active' },
      '330': { active: true, matterRegistered: true, alexaType: 'SWITCH', alexaName: 'Retained identity', domoticzName: 'Retained identity' },
    },
  };
  cfg.devices['322'].temperatureSourceIdx = '325';
  writeConfigAtomically(configPath, cfg);
  let failNextPersist = false;
  const persist = () => {
    if (failNextPersist) {
      failNextPersist = false;
      throw new Error('simulated config persistence failure');
    }
    writeConfigAtomically(configPath, cfg);
  };
  const calls = [];
  const domoticz = {
    getDevices: async () => inventory.map((idx) => ({ idx, Name: cfg.devices[idx]?.domoticzName || `Device ${idx}`, Type: 'Light/Switch', SwitchType: 'On/Off', Status: 'Off' })),
    switchLight: async (...args) => calls.push(['switchlight', ...args]),
    switchScene: async (...args) => calls.push(['switchscene', ...args]),
    setLevel: async (...args) => calls.push(['setlevel', ...args]),
    setSetpoint: async (...args) => calls.push(['setsetpoint', ...args]),
  };
  let store;
  let bridge;
  let apiServer;
  try {
    store = new DeviceStore({ cfg, persist, domoticz });
    await store.refresh();
    assert.equal(cfg.devices['324'].active, false, 'normal inventory discovery creates the unactivated config entry');
    assert.notEqual(cfg.devices['324'].matterRegistered, true, 'inventory discovery must not register Matter');
    assert.equal(store.records.get('324').matterRegistered, false);
    bridge = new MatterBridge({ deviceStore: store, dataDir: path.join(tempDir, 'matter-app-data'), logger: { log() {}, error() {} } });
    await bridge.start();

    // This is the reported lifecycle: IDX 324 disappears after discovery,
    // with no activation or explicit settings change in between.
    inventory = inventory.filter((idx) => idx !== '324');
    await store.refresh();
    assert.equal(store.records.get('324').available, false);
    assert.equal(bridge.getOrphanRemovalStatus('324').canRemove, true);

    const domoticzState = createDomoticzStatus();
    const updateStatus = (diagnostics) => recordValidDomoticzInventory(domoticzState, diagnostics, domoticzState.inventoryCheckedAt ?? Date.now());
    updateStatus({ missingActiveDevices: store.missingActiveDevices, missingInactiveDevices: store.missingInactiveDevices });
    store.on('diagnostics-changed', updateStatus);

    const app = express();
    app.use(express.json());
    app.use('/api', createDeviceApiRouter({ deviceStore: store, matter: bridge }));
    apiServer = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const apiBase = `http://127.0.0.1:${apiServer.address().port}/api`;
    const devicesResponse = await fetch(`${apiBase}/devices`);
    const orphanApiRecord = (await devicesResponse.json()).devices.find((device) => device.idx === '324');
    assert.equal(orphanApiRecord.orphanRemoval.canRemove, true, 'device API must expose the action eligibility to the UI');

    const unrelatedNumbers = new Map(['321', '322'].map((idx) => [idx, bridge.endpoints.get(`domlink-${idx}`).number]));
    await bridge.retireDevice('323', '323');
    assert.equal(bridge.getOrphanRemovalStatus('323').canRemove, false, 'retired IDX 323 must not be offered for orphan cleanup');
    await assert.rejects(bridge.removeOrphanedDevice('323', '323'), /Ruhestellungsdatensatz/);

    assert.equal(bridge.getOrphanRemovalStatus('324').canRemove, true);
    assert.equal(bridge.getOrphanRemovalStatus('326').canRemove, false, 'present inventory entries cannot be removed');
    assert.equal(bridge.getOrphanRemovalStatus('325').canRemove, false, 'a configured reference blocks cleanup');
    assert.match(bridge.getOrphanRemovalStatus('325').reason, /verweisen/);
    assert.equal(bridge.getOrphanRemovalStatus('327').canRemove, false, 'active but never-registered config is inconsistent');
    assert.equal(bridge.getOrphanRemovalStatus('321').canRemove, false, 'registered endpoint is not an orphan');

    inventory = inventory.filter((idx) => idx !== '322');
    await store.refresh();
    assert.equal(bridge.getOrphanRemovalStatus('322').canRemove, false, 'missing registered Matter endpoints cannot be removed as orphans');
    assert.match(bridge.getOrphanRemovalStatus('322').reason, /bei Matter registriert/);
    await assert.rejects(bridge.removeOrphanedDevice('322', '322'), /bei Matter registriert/);
    inventory.push('322');
    await store.refresh();

    const registered321 = { ...cfg.devices['321'] };
    cfg.devices['321'].active = false;
    cfg.devices['321'].matterRegistered = false;
    store.records.get('321').active = false;
    store.records.get('321').matterRegistered = false;
    inventory = inventory.filter((idx) => idx !== '321');
    await store.refresh();
    assert.equal(bridge.getOrphanRemovalStatus('321').canRemove, false, 'an active Matter endpoint identity blocks cleanup even if config is inconsistent');
    assert.match(bridge.getOrphanRemovalStatus('321').reason, /noch aktiv/);
    await assert.rejects(bridge.removeOrphanedDevice('321', '321'), /noch aktiv/);
    Object.assign(cfg.devices['321'], registered321);
    store.records.get('321').active = true;
    store.records.get('321').matterRegistered = true;
    inventory.push('321');
    await store.refresh();

    store.markUnavailable(new Error('simulated Domoticz outage'));
    assert.equal(bridge.getOrphanRemovalStatus('324').canRemove, false, 'a stale snapshot is not a current valid inventory');
    await assert.rejects(bridge.removeOrphanedDevice('324', '324'), /gültige aktuelle Domoticz-Inventur/);
    await store.refresh();

    // Create a retained SDK identity for an otherwise orphan-shaped config.
    const retainedEndpoint = bridge.endpoints.get('domlink-330');
    await retainedEndpoint.close();
    bridge.endpoints.delete('domlink-330');
    cfg.devices['330'].active = false;
    cfg.devices['330'].matterRegistered = false;
    store.records.get('330').active = false;
    store.records.get('330').matterRegistered = false;
    persist();
    inventory = inventory.filter((idx) => idx !== '330');
    await store.refresh();
    updateStatus({ missingActiveDevices: store.missingActiveDevices, missingInactiveDevices: store.missingInactiveDevices });
    const retainedStatus = bridge.getOrphanRemovalStatus('330');
    assert.equal(retainedStatus.canRemove, false);
    assert.match(retainedStatus.reason, /Matter-Speicher/);
    await assert.rejects(bridge.removeOrphanedDevice('330', '330'), /Matter-Speicher/);

    const beforeConfig = structuredClone(cfg);
    const orphanRecord = store.records.get('324');
    const matterIdentitySnapshot = () => {
      const aggregatorStore = bridge.server.env.get(ServerNodeStore).endpointStores.storeForEndpoint(bridge.aggregator);
      const identities = [];
      aggregatorStore.visit((saved) => identities.push([saved.id, saved.number]));
      return identities.sort(([a], [b]) => a.localeCompare(b));
    };
    const identitiesBeforeFailure = matterIdentitySnapshot();
    const endpointNumbersBeforeFailure = new Map(Array.from(bridge.endpoints, ([id, endpoint]) => [id, endpoint.number]));
    failNextPersist = true;
    const failedRemoval = await fetch(`${apiBase}/devices/324/remove-orphan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmIdx: '324' }),
    });
    assert.equal(failedRemoval.status, 500, 'the API must report configuration persistence failure');
    assert.match((await failedRemoval.text()), /Entfernung fehlgeschlagen/);
    assert.deepEqual(cfg, beforeConfig, 'failed persistence restores the original config entry');
    assert.strictEqual(store.records.get('324'), orphanRecord, 'failed persistence restores the original in-memory record');
    assert.deepEqual(new Map(Array.from(bridge.endpoints, ([id, endpoint]) => [id, endpoint.number])), endpointNumbersBeforeFailure);
    assert.deepEqual(matterIdentitySnapshot(), identitiesBeforeFailure, 'failed persistence must not change Matter storage');
    assert.ok(store.missingInactiveDevices.some((device) => device.idx === '324'), 'failed persistence leaves diagnostics unchanged');

    const resultResponse = await fetch(`${apiBase}/devices/324/remove-orphan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmIdx: '324' }),
    });
    assert.equal(resultResponse.status, 200);
    const result = await resultResponse.json();
    assert.deepEqual(result, { ok: true, removedIdx: '324' });
    const expectedConfig = structuredClone(beforeConfig);
    delete expectedConfig.devices['324'];
    assert.deepEqual(cfg, expectedConfig, 'only the orphan configuration key is removed');
    assert.equal(store.records.has('324'), false);
    assert.deepEqual(new Map(['321', '322'].map((idx) => [idx, bridge.endpoints.get(`domlink-${idx}`).number])), unrelatedNumbers);
    assert.equal(bridge.endpoints.has('domlink-324'), false);
    assert.equal(bridge.getOrphanRemovalStatus('324').canRemove, false);
    assert.equal(store.missingInactiveDevices.some((device) => device.idx === '324'), false, 'diagnostics are updated immediately after removal');
    assert.ok(store.missingInactiveDevices.some((device) => device.idx === '325'), 'other missing-device diagnostics remain');
    assert.ok(store.missingInactiveDevices.some((device) => device.idx === '330'), 'unrelated retained diagnostics remain');
    assert.equal(domoticzState.missingInactiveDevices.some((device) => device.idx === '324'), false, 'displayed status data updates without another poll');
    assert.ok(domoticzState.missingInactiveDevices.some((device) => device.idx === '325'));
    assert.deepEqual(calls, [], 'orphan cleanup must not issue Domoticz control commands');

    const diskConfig = await readConfig(configPath);
    assert.deepEqual(diskConfig, expectedConfig, 'the isolated config file contains only the intended removal');
  } finally {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    await bridge?.stop();
    if (previousPort === undefined) delete process.env.MATTER_PORT;
    else process.env.MATTER_PORT = previousPort;
    if (previousMdnsInterface === undefined) Environment.default.vars.set('mdns.networkInterface', undefined);
    else Environment.default.vars.set('mdns.networkInterface', previousMdnsInterface);
    if (previousLogLevel === undefined) Environment.default.vars.set('log.level', undefined);
    else Environment.default.vars.set('log.level', previousLogLevel);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
