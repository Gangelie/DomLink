import { buildPublicStatus } from './domoticzStatus.js';

export function createSingleFlightPoll(poll) {
  let inFlight = null;
  return async function pollOnce() {
    if (inFlight) return inFlight;
    const current = Promise.resolve().then(poll);
    inFlight = current;
    try {
      return await current;
    } finally {
      if (inFlight === current) inFlight = null;
    }
  };
}

// Mounted beneath the authenticated /api middleware in server.js.
export function createDomoticzRefreshHandler({ pollDomoticz, deviceStore, domoticzState, matter }) {
  return async (_req, res) => {
    await pollDomoticz();
    res.json({
      ok: true,
      devices: deviceStore.list(),
      status: buildPublicStatus(domoticzState, matter.getStatus()),
    });
  };
}
