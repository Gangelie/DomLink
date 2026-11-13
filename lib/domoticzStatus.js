import { retirementForDevice } from './deviceLifecycle.js';

export function safeDiagnosticError(error) {
  const code = String(error?.code || '').toUpperCase();
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  const message = String(error?.message || error || '').toLowerCase();

  // Never echo arbitrary HTTP/client exception text: it may contain a full URL,
  // authorization header, query credentials, Matter pairing data, or config.
  if (status === 401 || status === 403 || /http\s+(401|403)|unauthori[sz]ed|forbidden|authentication/.test(message)) {
    return 'Domoticz hat die Anfrage abgelehnt. Zugangsdaten und API-Berechtigungen prüfen.';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || /timeout|timed out|zeitüberschreitung/.test(message)) {
    return 'Zeitüberschreitung bei der Verbindung zu Domoticz.';
  }
  if (code === 'ECONNREFUSED' || /econnrefused|connection refused|verbindung abgelehnt/.test(message)) {
    return 'Verbindung zu Domoticz abgelehnt. Adresse, Port und Erreichbarkeit prüfen.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /enotfound|eai_again|dns/.test(message)) {
    return 'Domoticz-Host wurde nicht gefunden. Adresse und Netzwerk prüfen.';
  }
  if (code === 'ECONNRESET' || /econnreset|socket hang up|connection reset/.test(message)) {
    return 'Die Verbindung zu Domoticz wurde unterbrochen.';
  }
  if (/json|inventory|geräteliste|device list|malformed|ungültig/.test(message)) {
    return 'Domoticz hat keine gültige Geräteliste zurückgegeben.';
  }
  if (status >= 500) return `Domoticz meldet einen Serverfehler (HTTP ${status}).`;
  if (status >= 400) return `Domoticz hat die Anfrage mit HTTP ${status} abgelehnt.`;
  return 'Domoticz-Anfrage fehlgeschlagen. Verbindung und API-Antwort prüfen.';
}

export function createDomoticzStatus() {
  return {
    state: 'gray',
    online: false,
    connectionAvailable: null,
    inventoryValid: false,
    inventoryComplete: null,
    lastError: null,
    lastCheckedAt: null,
    inventoryCheckedAt: null,
    missingActiveCount: 0,
    missingInactiveCount: 0,
    missingActiveDevices: [],
    missingInactiveDevices: [],
  };
}

export function buildMissingDeviceDiagnostics(deviceConfigs, presentIdxs, retirements = {}) {
  const present = presentIdxs instanceof Set ? presentIdxs : new Set(Array.from(presentIdxs || [], String));
  const missingActiveDevices = [];
  const missingInactiveDevices = [];

  for (const [idx, config] of Object.entries(deviceConfigs || {})) {
    if (present.has(String(idx))) continue;
    const retirement = retirementForDevice(retirements, idx, config);
    if (retirement?.state === 'completed') continue;
    const device = {
      idx: String(idx),
      name: config.domoticzName || config.alexaName || null,
      alexaName: config.alexaName || config.domoticzName || null,
      alexaType: config.alexaType || 'SWITCH',
      active: config.active === true,
      matterRegistered: config.matterRegistered === true,
      ...(retirement ? { retirementState: retirement.state } : {}),
    };
    (device.active ? missingActiveDevices : missingInactiveDevices).push(device);
  }

  const byIdx = (a, b) => a.idx.localeCompare(b.idx, undefined, { numeric: true });
  missingActiveDevices.sort(byIdx);
  missingInactiveDevices.sort(byIdx);
  return { missingActiveDevices, missingInactiveDevices };
}

export function recordValidDomoticzInventory(status, diagnostics, checkedAt = Date.now()) {
  const active = diagnostics.missingActiveDevices;
  const inactive = diagnostics.missingInactiveDevices;
  status.state = active.length ? 'yellow' : 'green';
  status.online = true;
  status.connectionAvailable = true;
  status.inventoryValid = true;
  status.inventoryComplete = active.length === 0 && inactive.length === 0;
  status.lastError = null;
  status.lastCheckedAt = checkedAt;
  status.inventoryCheckedAt = checkedAt;
  status.missingActiveDevices = active;
  status.missingInactiveDevices = inactive;
  status.missingActiveCount = active.length;
  status.missingInactiveCount = inactive.length;
}

export function recordDomoticzFailure(status, error, checkedAt = Date.now()) {
  status.state = 'red';
  status.online = false;
  status.connectionAvailable = false;
  status.inventoryValid = false;
  status.inventoryComplete = null;
  status.lastError = safeDiagnosticError(error);
  status.lastCheckedAt = checkedAt;
}

export function buildPublicStatus(domoticz, matter) {
  return {
    domoticz: {
      state: domoticz.state,
      online: domoticz.online,
      connectionAvailable: domoticz.connectionAvailable,
      inventoryValid: domoticz.inventoryValid,
      inventoryComplete: domoticz.inventoryComplete,
      lastError: domoticz.lastError,
      lastCheckedAt: domoticz.lastCheckedAt,
      inventoryCheckedAt: domoticz.inventoryCheckedAt,
      missingActiveCount: domoticz.missingActiveCount,
      missingInactiveCount: domoticz.missingInactiveCount,
      missingActiveDevices: domoticz.missingActiveDevices,
      missingInactiveDevices: domoticz.missingInactiveDevices,
    },
    matter: {
      running: matter.running,
      commissioned: matter.commissioned,
      online: matter.online,
      deviceCount: matter.deviceCount,
      initializationPending: matter.initializationPending,
      initializationError: matter.initializationError ? safeDiagnosticError(matter.initializationError) : null,
    },
  };
}
