import { randomUUID } from 'node:crypto';

export function deviceInstanceId(idx, config = {}) {
  return config.instanceId ? `domlink-${idx}@${config.instanceId}` : `domlink-${idx}`;
}

export function matterEndpointIdentity(idx, config = {}) {
  return config.matterEndpointId || `d${idx}`;
}

export function matterSerialNumber(idx, config = {}) {
  if (!config.instanceId) return `domlink-${idx}`;
  const suffix = String(config.instanceId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 28);
  return `dl-${suffix}`;
}

export function retirementMatchesDevice(retirement, idx, config = {}) {
  if (!retirement || String(retirement.idx ?? idx) !== String(idx)) return false;
  return String(retirement.instanceId ?? '') === String(config.instanceId ?? '');
}

export function retirementForDevice(retirements, idx, config = {}) {
  for (const [key, retirement] of Object.entries(retirements || {})) {
    if (retirementMatchesDevice(retirement, retirement.idx ?? key.split('@', 1)[0], config)
      && String(retirement.idx ?? key.split('@', 1)[0]) === String(idx)) return retirement;
  }
  return undefined;
}

export function retirementEntriesForIdx(retirements, idx) {
  return Object.entries(retirements || {}).filter(([key, retirement]) =>
    String(retirement?.idx ?? key.split('@', 1)[0]) === String(idx));
}

export function retirementStorageKey(retirements, retirement) {
  const idx = String(retirement.idx);
  const current = retirements?.[idx];
  if (current === undefined || retirementMatchesDevice(current, idx, retirement)) return idx;
  const instance = retirement.instanceId || randomUUID();
  return `${idx}@${instance}`;
}

export function newDeviceGeneration(idx, device, config = {}) {
  const instanceId = randomUUID();
  const usedMatterEndpointIds = new Set([
    ...Object.values(config.devices || {}).map(item => item?.matterEndpointId).filter(Boolean),
    ...Object.values(config.matterRetirements || {}).map(item => item?.matterEndpointId).filter(Boolean),
  ]);
  let endpointSuffix;
  let matterEndpointId;
  do {
    endpointSuffix = randomUUID().replaceAll('-', '');
    matterEndpointId = `d${idx}-g${endpointSuffix}`;
  } while (usedMatterEndpointIds.has(matterEndpointId));
  return {
    instanceId,
    matterEndpointId,
    active: false,
    matterRegistered: false,
    alexaType: undefined,
    alexaName: device.Name,
    domoticzName: device.Name,
  };
}
