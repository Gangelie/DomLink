import express from 'express';
import { ALEXA_TYPES } from './deviceTypes.js';

export function createDeviceApiRouter({ deviceStore, matter }) {
  const router = express.Router();

  router.get('/devices', (req, res) => {
    const devices = deviceStore.list().map((device) => ({
      ...device,
      endpointNumber: device.retirement?.endpointNumber ?? matter.endpoints.get(device.deviceId)?.number ?? null,
      orphanRemoval: matter.getOrphanRemovalStatus?.(device.idx) ?? device.orphanRemoval,
    }));
    const archivedDevices = deviceStore.listRetiredArchive?.() || [];
    res.json({ devices, archivedDevices, alexaTypes: ALEXA_TYPES });
  });

  router.put('/devices/:idx', (req, res) => {
    try {
      const record = deviceStore.updateDeviceConfig(req.params.idx, req.body || {});
      res.json({ ok: true, device: record });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post('/devices/:idx/adopt-new', async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== 'confirmIdx') || typeof req.body.confirmIdx !== 'string') {
      return res.status(400).json({ ok: false, error: 'Ungültige Anfrage' });
    }
    if (req.body.confirmIdx !== String(req.params.idx)) return res.status(400).json({ ok: false, error: 'Bestätigung stimmt nicht mit dem Domoticz-IDX überein.' });
    try {
      const device = await matter.adoptRetiredDeviceAsNew(req.params.idx, req.body.confirmIdx);
      return res.json({ ok: true, device });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.statusCode ? err.message : 'Übernahme fehlgeschlagen; Konfiguration bitte prüfen.' });
    }
  });

  router.post('/devices/:idx/matter/retire', async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== 'confirmIdx') || typeof req.body.confirmIdx !== 'string') {
      return res.status(400).json({ ok: false, error: 'Ungültige Anfrage' });
    }
    try {
      const result = await matter.retireDevice(req.params.idx, req.body.confirmIdx);
      const item = deviceStore.list().find((entry) => entry.idx === String(req.params.idx));
      const device = item && { ...item, endpointNumber: item.retirement?.endpointNumber ?? matter.endpoints.get(item.deviceId)?.number ?? null };
      return res.json({ ...result, device });
    } catch (err) {
      const status = err.statusCode || 500;
      const error = status >= 500 ? 'Entfernung fehlgeschlagen; Status sicherheitshalber prüfen' : err.message;
      return res.status(status).json({ ok: false, recoveryRequired: err.recoveryRequired === true, error });
    }
  });

  router.post('/devices/:idx/remove-orphan', async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== 'confirmIdx') || typeof req.body.confirmIdx !== 'string') {
      return res.status(400).json({ ok: false, error: 'Ungültige Anfrage' });
    }
    try {
      const result = await matter.removeOrphanedDevice(req.params.idx, req.body.confirmIdx);
      return res.json(result);
    } catch (err) {
      const status = err.statusCode || 500;
      const error = status >= 500 ? 'Entfernung fehlgeschlagen; DomLink-Konfiguration bitte prüfen.' : err.message;
      return res.status(status).json({ ok: false, error });
    }
  });

  return router;
}
