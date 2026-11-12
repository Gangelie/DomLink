import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatterStarter } from '../lib/matterStartup.js';
import DeviceStore from '../lib/deviceStore.js';
import MatterBridge from '../lib/matterBridge.js';

test('Matter startup is single-flight across recovery and polling and retries after failure', async () => {
  let releaseFirst;
  let attempts = 0;
  const matter = {
    server: null,
    initializationError: null,
    start: async () => {
      attempts += 1;
      if (attempts === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        throw new Error('simulated startup failure');
      }
      matter.server = { running: true };
    },
  };
  const deviceStore = { canRestoreRegisteredEndpoints: () => true };
  const errors = [];
  const startWhenReady = createMatterStarter({ matter, deviceStore, logger: { error: (...args) => errors.push(args) } });

  const recoveryAttempt = startWhenReady();
  const pollAttempt = startWhenReady();
  await Promise.resolve();
  assert.equal(attempts, 1);
  releaseFirst();
  await Promise.all([recoveryAttempt, pollAttempt]);
  assert.equal(matter.server, null);
  assert.equal(matter.initializationError, 'simulated startup failure');
  assert.equal(errors.length, 1);

  await startWhenReady();
  assert.equal(attempts, 2);
  assert.deepEqual(matter.server, { running: true });
  assert.equal(matter.initializationError, null);
});

test('Matter startup waits for reconstructible metadata and does not start an empty bridge', async () => {
  let attempts = 0;
  const matter = { server: null, start: async () => { attempts += 1; } };
  let canRestore = false;
  const startWhenReady = createMatterStarter({ matter, deviceStore: { canRestoreRegisteredEndpoints: () => canRestore }, logger: { error() {} } });
  await startWhenReady();
  assert.equal(attempts, 0);
  canRestore = true;
  await startWhenReady();
  assert.equal(attempts, 1);
});

test('MatterBridge releases a failed partial initialization and allows a clean retry', async () => {
  let factoryCalls = 0;
  let closes = 0;
  let starts = 0;
  const event = { on() {} };
  const serverNodeFactory = async () => {
    factoryCalls += 1;
    if (factoryCalls === 1) return { add: async () => { throw new Error('add failed'); }, close: async () => { closes += 1; } };
    return {
      add: async () => {},
      start: async () => { starts += 1; },
      close: async () => { closes += 1; },
      lifecycle: { commissioned: event, decommissioned: event, online: event, offline: event, isCommissioned: false, isOnline: true },
    };
  };
  const store = new DeviceStore({ cfg: { devices: {} }, persist() {}, domoticz: { getDevices: async () => [] } });
  const bridge = new MatterBridge({ deviceStore: store, dataDir: '/tmp/domlink-matter-start-retry', logger: { log() {}, error() {} }, serverNodeFactory });

  await assert.rejects(bridge.start(), /add failed/);
  assert.equal(bridge.server, null);
  assert.equal(bridge.aggregator, null);
  assert.equal(bridge.endpoints.size, 0);
  assert.equal(bridge.acceptCommands, false);
  assert.equal(closes, 1);

  await bridge.start();
  assert.equal(factoryCalls, 2);
  assert.equal(starts, 1);
  assert.equal(bridge.acceptCommands, true);
  await bridge.stop();
  assert.equal(closes, 2);
});
