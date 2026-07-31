import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

import * as configStore from './lib/config.js';
import { createAuthRouter, requireAuth } from './lib/auth.js';
import DomoticzClient from './lib/domoticz.js';
import DeviceStore from './lib/deviceStore.js';
import MatterBridge from './lib/matterBridge.js';
import { ALEXA_TYPES } from './lib/deviceTypes.js';
import * as eventLog from './lib/eventLog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = Number(process.env.DOMOTICZ_POLL_INTERVAL_MS || 25000);

const cfg = configStore.load();
const persist = () => configStore.save(cfg);

const domoticz = new DomoticzClient(() => cfg.domoticz);
const deviceStore = new DeviceStore({ cfg, persist, domoticz });
const matter = new MatterBridge({ deviceStore, dataDir: configStore.DATA_DIR, logger: console });

const domoticzState = { online: false, lastError: null, lastCheckedAt: null };

async function pollDomoticz() {
  try {
    await deviceStore.refresh();
    domoticzState.online = true;
    domoticzState.lastError = null;
  } catch (err) {
    domoticzState.online = false;
    domoticzState.lastError = err.message;
  }
  domoticzState.lastCheckedAt = Date.now();
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(
  session({
    secret: cfg.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      secure: process.env.COOKIE_SECURE === 'true',
    },
  })
);

app.use('/api/auth', createAuthRouter(cfg, persist));
app.use('/api', requireAuth);

// ---------------------------------------------------------------------
// Status (top bar)
// ---------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({
    domoticz: domoticzState,
    matter: matter.getStatus(),
  });
});

// ---------------------------------------------------------------------
// Domoticz settings
// ---------------------------------------------------------------------
app.get('/api/config/domoticz', (req, res) => {
  res.json(cfg.domoticz);
});

app.put('/api/config/domoticz', (req, res) => {
  const { url, port, username, password } = req.body || {};
  cfg.domoticz = {
    url: (url || '').trim(),
    port: (port || '').toString().trim(),
    username: (username || '').trim(),
    password: password || '',
  };
  persist();
  pollDomoticz();
  res.json({ ok: true });
});

app.post('/api/domoticz/test', async (req, res) => {
  const testConfig = {
    url: (req.body.url || cfg.domoticz.url || '').trim(),
    port: (req.body.port || cfg.domoticz.port || '').toString().trim(),
    username: req.body.username !== undefined ? req.body.username : cfg.domoticz.username,
    password: req.body.password !== undefined ? req.body.password : cfg.domoticz.password,
  };
  const testClient = new DomoticzClient(() => testConfig);
  try {
    const result = await testClient.testConnection();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// Matter bridge
// ---------------------------------------------------------------------
app.get('/api/matter/status', async (req, res) => {
  const status = matter.getStatus();
  const qrDataUrl = status.pairingCode ? await matter.getPairingQrCodeDataUrl() : null;
  res.json({ ...status, qrDataUrl });
});

app.post('/api/matter/reset', async (req, res) => {
  try {
    await matter.resetCommissioning();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------
// Live-Protokoll (Server-Sent Events)
// ---------------------------------------------------------------------
app.get('/api/log/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  for (const entry of eventLog.getBuffer()) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const unsubscribe = eventLog.onEntry((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

// ---------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------
app.get('/api/devices', (req, res) => {
  res.json({ devices: deviceStore.list(), alexaTypes: ALEXA_TYPES });
});

app.put('/api/devices/:idx', (req, res) => {
  try {
    const record = deviceStore.updateDeviceConfig(req.params.idx, req.body || {});
    res.json({ ok: true, device: record });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/devices/refresh', async (req, res) => {
  await pollDomoticz();
  res.json({ ok: true, devices: deviceStore.list() });
});

// ---------------------------------------------------------------------
// Static SPA
// ---------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`DomLink läuft auf Port ${PORT}`);

  // Matter registers currently-active devices once at startup, so the
  // deviceStore must be populated from a real Domoticz poll first - starting
  // both in parallel is a race that silently drops whichever active devices
  // haven't loaded yet.
  await pollDomoticz();
  setInterval(pollDomoticz, POLL_INTERVAL_MS);

  matter.start().catch((err) => console.error('Matter: Start fehlgeschlagen:', err.message));
});

process.on('SIGTERM', async () => {
  await matter.stop();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await matter.stop();
  process.exit(0);
});
