import test from 'node:test';
import assert from 'node:assert/strict';
import DeviceStore from '../lib/deviceStore.js';
import MatterBridge from '../lib/matterBridge.js';
import {
  buildMissingDeviceDiagnostics,
  buildPublicStatus,
  createDomoticzStatus,
  recordDomoticzFailure,
  recordValidDomoticzInventory,
  safeDiagnosticError,
} from '../lib/domoticzStatus.js';

const configured = {
  '1': { active: true, matterRegistered: true, alexaType: 'SWITCH', domoticzName: 'Active Lamp', alexaName: 'Wohnzimmer' },
  '5': { active: false, matterRegistered: true, alexaType: 'SWITCH', domoticzName: 'Test Scene', alexaName: 'Probe' },
  '323': { active: false, matterRegistered: true, alexaType: 'SWITCH', domoticzName: 'Nacht', alexaName: 'Nacht' },
  '325': { active: false, matterRegistered: true, alexaType: 'SELECTOR', domoticzName: 'Test Switch 2', alexaName: 'Test Switch 2' },
};

test('valid complete inventory is GREEN', () => {
  const status = createDomoticzStatus();
  const diagnostics = buildMissingDeviceDiagnostics(configured, new Set(Object.keys(configured)));
  recordValidDomoticzInventory(status, diagnostics, 100);
  assert.equal(status.state, 'green');
  assert.equal(status.connectionAvailable, true);
  assert.equal(status.inventoryValid, true);
  assert.equal(status.inventoryComplete, true);
  assert.equal(status.missingActiveCount, 0);
  assert.equal(status.lastCheckedAt, 100);
});

test('only missing inactive devices remain GREEN and are listed as informational', () => {
  const status = createDomoticzStatus();
  const diagnostics = buildMissingDeviceDiagnostics(configured, new Set(['1']));
  recordValidDomoticzInventory(status, diagnostics, 200);
  assert.equal(status.state, 'green');
  assert.equal(status.inventoryComplete, false);
  assert.equal(status.missingActiveCount, 0);
  assert.equal(status.missingInactiveCount, 3);
  assert.deepEqual(status.missingInactiveDevices.map((device) => device.idx), ['5', '323', '325']);
});

test('a missing active configured device makes a valid connection YELLOW', () => {
  const status = createDomoticzStatus();
  const diagnostics = buildMissingDeviceDiagnostics(configured, new Set(['5', '323', '325']));
  recordValidDomoticzInventory(status, diagnostics, 300);
  assert.equal(status.state, 'yellow');
  assert.equal(status.connectionAvailable, true);
  assert.equal(status.inventoryValid, true);
  assert.equal(status.missingActiveCount, 1);
  assert.deepEqual(status.missingActiveDevices[0], {
    idx: '1', name: 'Active Lamp', alexaName: 'Wohnzimmer', alexaType: 'SWITCH', active: true, matterRegistered: true,
  });
});

test('connection, authentication, timeout and malformed-response failures are RED', () => {
  for (const message of ['ECONNREFUSED', 'HTTP 401 authentication failed', 'timeout', 'Ungültige Domoticz-Geräteliste']) {
    const status = createDomoticzStatus();
    recordDomoticzFailure(status, new Error(message), 400);
    assert.equal(status.state, 'red');
    assert.equal(status.online, false);
    assert.equal(status.connectionAvailable, false);
    assert.equal(status.inventoryValid, false);
    assert.ok(status.lastError);
    assert.doesNotMatch(status.lastError, /GEHEIMER_WERT|password|token|secret/i);
  }
});

test('status stays GRAY until the first connection check completes', () => {
  const status = createDomoticzStatus();
  assert.equal(status.state, 'gray');
  assert.equal(status.connectionAvailable, null);
  assert.equal(status.inventoryValid, false);
  assert.equal(status.lastCheckedAt, null);
});

test('a returning active device automatically restores GREEN status', () => {
  const status = createDomoticzStatus();
  recordValidDomoticzInventory(status, buildMissingDeviceDiagnostics(configured, new Set(['5', '323', '325'])), 500);
  assert.equal(status.state, 'yellow');
  recordValidDomoticzInventory(status, buildMissingDeviceDiagnostics(configured, new Set(Object.keys(configured))), 600);
  assert.equal(status.state, 'green');
  assert.equal(status.missingActiveCount, 0);
  assert.equal(status.inventoryComplete, true);
});

test('inactive missing devices stay Matter-registered and never trigger endpoint deletion', async () => {
  const cfg = { devices: Object.fromEntries(Object.entries(configured).filter(([, device]) => !device.active)) };
  const store = new DeviceStore({ cfg, persist() {}, domoticz: { getDevices: async () => [] } });
  const bridge = new MatterBridge({ deviceStore: store, dataDir: '/tmp/domlink-diagnostics-test', logger: { log() {}, error() {} } });
  const endpoints = new Map();
  let closes = 0;
  for (const record of store.getRegisteredDevices()) {
    const endpoint = { set: async () => {}, close: async () => { closes += 1; } };
    endpoints.set(record.deviceId, endpoint);
    bridge.endpoints.set(record.deviceId, endpoint);
  }

  await store.refresh();
  assert.deepEqual(store.missingInactiveDevices.map((device) => device.idx), ['5', '323', '325']);
  assert.equal(store.getRegisteredDevices().length, 3);
  assert.equal(bridge.endpoints.size, 3);
  assert.equal(closes, 0);
  bridge.removeAllListeners();
});

test('diagnostics include saved identity fields but never expose credentials', () => {
  const diagnostics = buildMissingDeviceDiagnostics({
    '323': { domoticzName: 'Nacht', alexaName: 'Nacht', alexaType: 'SWITCH', active: false, matterRegistered: true },
    '325': { domoticzName: 'Test Switch 2', alexaName: 'Test Switch 2', alexaType: 'SELECTOR', active: false, matterRegistered: true },
  }, []);
  assert.deepEqual(diagnostics.missingInactiveDevices.map(({ idx, name, alexaName, alexaType, active, matterRegistered }) => ({ idx, name, alexaName, alexaType, active, matterRegistered })), [
    { idx: '323', name: 'Nacht', alexaName: 'Nacht', alexaType: 'SWITCH', active: false, matterRegistered: true },
    { idx: '325', name: 'Test Switch 2', alexaName: 'Test Switch 2', alexaType: 'SELECTOR', active: false, matterRegistered: true },
  ]);

  const status = createDomoticzStatus();
  recordDomoticzFailure(status, new Error('request https://daniel:secret@example.test/json?token=abc password=hunter2'), 700);
  const publicPayload = buildPublicStatus(status, {
    running: true, commissioned: false, online: false, deviceCount: 3,
    pairingCode: { manual: 'MATTER-MANUAL-SECRET', qr: 'MATTER-QR-SECRET' },
    initializationError: 'token=private-token',
  });
  const json = JSON.stringify(publicPayload);
  assert.doesNotMatch(json, /secret|abc|hunter2|daniel/);
  assert.doesNotMatch(json, /MATTER-MANUAL-SECRET|MATTER-QR-SECRET|private-token|pairingCode/);
  assert.ok(publicPayload.domoticz.lastError);
  assert.deepEqual(Object.keys(publicPayload.domoticz).sort(), [
    'connectionAvailable', 'inventoryCheckedAt', 'inventoryComplete', 'inventoryValid',
    'lastCheckedAt', 'lastError', 'missingActiveCount', 'missingActiveDevices',
    'missingInactiveCount', 'missingInactiveDevices', 'online', 'state',
  ].sort());
  assert.deepEqual(Object.keys(publicPayload.matter).sort(), [
    'commissioned', 'deviceCount', 'initializationError', 'initializationPending', 'online', 'running',
  ].sort());
});

test('diagnostic errors normalize credential-bearing URLs, headers and arbitrary exception strings', () => {
  const sensitiveMessages = [
    'GET https://user:pass@example.local/json?apikey=GEHEIMER_WERT',
    'GET https://example.local/json?api_key=API_SECRET&auth=AUTH_SECRET&access_token=ACCESS_SECRET',
    'password=PASSWORD_SECRET token=TOKEN_SECRET session=SESSION_SECRET',
    'Authorization: Bearer AUTH_HEADER_SECRET',
    'Matter manual pairing code 1234-567-890 and QR credential QR_SECRET',
  ];
  for (const message of sensitiveMessages) {
    const safe = safeDiagnosticError(new Error(message));
    assert.doesNotMatch(safe, /GEHEIMER_WERT|API_SECRET|AUTH_SECRET|ACCESS_SECRET|PASSWORD_SECRET|TOKEN_SECRET|SESSION_SECRET|AUTH_HEADER_SECRET|QR_SECRET|1234-567-890|user|pass@example/i);
    assert.ok(safe.length > 8);
  }
  assert.match(safeDiagnosticError(Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' })), /Zeitüberschreitung/);
  assert.match(safeDiagnosticError(Object.assign(new Error('request failed'), { response: { status: 401 } })), /Zugangsdaten/);
});
