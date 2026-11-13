import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import {
  createDomoticzRefreshHandler,
  createSingleFlightPoll,
} from '../lib/domoticzApi.js';
import {
  buildMissingDeviceDiagnostics,
  createDomoticzStatus,
  recordDomoticzFailure,
  recordValidDomoticzInventory,
} from '../lib/domoticzStatus.js';
import { createAuthRouter, requireAuth } from '../lib/auth.js';
import { createDeviceApiRouter } from '../lib/deviceApi.js';

test('HTTP retirement route enforces session auth, confirmation, dispatch, and safe errors', async (t) => {
  let failSensitive = false;
  const calls = [];
  const deviceStore = {
    list: () => [{ idx: '512', deviceId: 'domlink-512', retirement: null }],
    updateDeviceConfig() {},
  };
  const matter = {
    endpoints: new Map(),
    async retireDevice(idx, confirmIdx) {
      calls.push([idx, confirmIdx]);
      if (failSensitive) throw Object.assign(new Error('private token=SECRET QR=PAIRING'), { statusCode: 500, recoveryRequired: true });
      if (confirmIdx !== idx) throw Object.assign(new Error('Bestätigung stimmt nicht'), { statusCode: 400 });
      if (idx !== '512') throw Object.assign(new Error('Unbekanntes Gerät'), { statusCode: 404 });
      return { ok: true, alreadyRetired: false, retirement: { idx, state: 'completed' } };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: false }));
  const authConfig = { passwordHash: bcrypt.hashSync('test-password', 4), mustChangePassword: false };
  app.use('/api/auth', createAuthRouter(authConfig, () => {}));
  app.use('/api', requireAuth);
  app.use('/api', createDeviceApiRouter({ deviceStore, matter }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = '/api/devices/512/matter/retire';
  const unauthenticated = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmIdx: '512' }) });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(calls, []);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const post = (confirmIdx) => fetch(`${base}${path}`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmIdx }),
  });
  const invalid = await post('999');
  assert.equal(invalid.status, 400);
  assert.deepEqual(calls.at(-1), ['512', '999']);
  const success = await post('512');
  assert.equal(success.status, 200);
  assert.deepEqual(calls.at(-1), ['512', '512']);

  failSensitive = true;
  const failure = await post('512');
  assert.equal(failure.status, 500);
  const body = await failure.text();
  assert.doesNotMatch(body, /SECRET|PAIRING|private token/);
});

test('orphan removal route requires authentication and exact IDX confirmation', async (t) => {
  const calls = [];
  let failPersist = false;
  const deviceStore = {
    list: () => [{ idx: '324', deviceId: 'domlink-324', retirement: null }],
    updateDeviceConfig() {},
  };
  const matter = {
    endpoints: new Map(),
    async removeOrphanedDevice(idx, confirmIdx) {
      calls.push([idx, confirmIdx]);
      if (failPersist) throw Object.assign(new Error('private path /data/config.json secret=opaque'), { statusCode: 500 });
      if (idx !== '324' || confirmIdx !== '324') throw Object.assign(new Error('Bestätigung stimmt nicht mit dem IDX überein.'), { statusCode: 400 });
      return { ok: true, removedIdx: idx };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: false }));
  const authConfig = { passwordHash: bcrypt.hashSync('test-password', 4), mustChangePassword: false };
  app.use('/api/auth', createAuthRouter(authConfig, () => {}));
  app.use('/api', requireAuth);
  app.use('/api', createDeviceApiRouter({ deviceStore, matter }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/devices/324/remove-orphan`;
  const unauthenticated = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmIdx: '324' }) });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(calls, []);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const post = (body) => fetch(endpoint, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const invalid = await post({ confirmIdx: '323' });
  assert.equal(invalid.status, 400);
  const invalidShape = await post({ confirmIdx: '324', other: 'unexpected' });
  assert.equal(invalidShape.status, 400);
  const success = await post({ confirmIdx: '324' });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { ok: true, removedIdx: '324' });
  assert.deepEqual(calls, [['324', '323'], ['324', '324']]);
  failPersist = true;
  const failed = await post({ confirmIdx: '324' });
  assert.equal(failed.status, 500);
  const failureBody = await failed.text();
  assert.match(failureBody, /Entfernung fehlgeschlagen/);
  assert.doesNotMatch(failureBody, /config\.json|opaque|private path/);
});

test('authenticated POST /api/devices/refresh polls and reports status for presence, absence, outage and recovery', async (t) => {
  const configs = {
    '1': { active: true, matterRegistered: true, alexaName: 'Lampe', alexaType: 'SWITCH' },
    '5': { active: false, matterRegistered: true, alexaName: 'Szene', alexaType: 'SWITCH' },
  };
  let inventory = ['1'];
  let offline = false;
  let pollCount = 0;
  const domoticzState = createDomoticzStatus();
  const deviceStore = { list: () => [] };
  const matter = { getStatus: () => ({ running: true, commissioned: true, online: true, deviceCount: 2 }) };
  const pollDomoticz = createSingleFlightPoll(async () => {
    pollCount += 1;
    if (offline) {
      recordDomoticzFailure(domoticzState, Object.assign(new Error('private URL https://me:secret@example.local?apikey=secret'), { code: 'ECONNREFUSED' }));
      return;
    }
    recordValidDomoticzInventory(domoticzState, buildMissingDeviceDiagnostics(configs, new Set(inventory)));
  });

  const app = express();
  app.use('/api', (req, res, next) => req.headers.authorization === 'Bearer test' ? next() : res.sendStatus(401));
  app.post('/api/devices/refresh', createDomoticzRefreshHandler({ pollDomoticz, deviceStore, domoticzState, matter }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/devices/refresh`;
  const refresh = async () => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test' } });
    assert.equal(response.status, 200);
    return response.json();
  };

  const complete = await refresh();
  assert.equal(complete.status.domoticz.state, 'green');
  assert.equal(complete.status.domoticz.missingInactiveCount, 1);

  inventory = [];
  const missing = await refresh();
  assert.equal(missing.status.domoticz.state, 'yellow');
  assert.equal(missing.status.domoticz.missingActiveDevices[0].idx, '1');
  assert.equal(missing.status.domoticz.missingInactiveDevices[0].idx, '5');

  offline = true;
  const failed = await refresh();
  assert.equal(failed.status.domoticz.state, 'red');
  assert.doesNotMatch(JSON.stringify(failed), /secret|apikey|me:/i);

  offline = false;
  inventory = ['1'];
  const recovered = await refresh();
  assert.equal(recovered.status.domoticz.state, 'green');
  assert.equal(recovered.status.domoticz.missingActiveCount, 0);
  assert.equal(pollCount, 4);

  const unauthorized = await fetch(url, { method: 'POST' });
  assert.equal(unauthorized.status, 401);
  assert.equal(pollCount, 4);
});

test('overlapping manual refresh requests share one in-flight inventory poll', async () => {
  let pollCount = 0;
  let release;
  const poll = createSingleFlightPoll(() => new Promise((resolve) => {
    pollCount += 1;
    release = resolve;
  }));
  const first = poll();
  const second = poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pollCount, 1);
  release();
  await Promise.all([first, second]);

  const third = poll();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await third;
  assert.equal(pollCount, 2);
});
