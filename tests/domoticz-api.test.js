import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
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
