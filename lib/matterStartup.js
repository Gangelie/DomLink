export function createMatterStarter({ matter, deviceStore, logger = console }) {
  let startPromise = null;

  return async function startMatterWhenReady() {
    if (startPromise) return startPromise;
    if (matter.server || !deviceStore.canRestoreRegisteredEndpoints()) return;

    const attempt = Promise.resolve().then(async () => {
      try {
        await matter.start();
        matter.initializationError = null;
      } catch (err) {
        matter.initializationError = err.message;
        logger.error('Matter: Start fehlgeschlagen:', err.message);
      }
    });
    startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (startPromise === attempt) startPromise = null;
    }
  };
}
