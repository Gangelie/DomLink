const express = require('express');
const session = require('express-session');
const path = require('path');

const configStore = require('./lib/config');
const { createAuthRouter, requireAuth } = require('./lib/auth');
const DomoticzClient = require('./lib/domoticz');
const DeviceStore = require('./lib/deviceStore');
const VshBridge = require('./lib/vsh');
const { ALEXA_TYPES } = require('./lib/deviceTypes');

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MS = Number(process.env.DOMOTICZ_POLL_INTERVAL_MS || 25000);

const cfg = configStore.load();
const persist = () => configStore.save(cfg);

const domoticz = new DomoticzClient(() => cfg.domoticz);
const deviceStore = new DeviceStore({ cfg, persist, domoticz });
const vsh = new VshBridge({ cfg, persist, deviceStore, logger: console });

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
    vsh: vsh.getStatus(),
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
// VSH / Alexa settings
// ---------------------------------------------------------------------
app.get('/api/config/vsh', (req, res) => {
  res.json({
    backendUrl: cfg.vsh.backendUrl,
    lwaClientId: cfg.vsh.lwaClientId,
    status: vsh.getStatus(),
  });
});

app.put('/api/config/vsh', (req, res) => {
  const { backendUrl, lwaClientId } = req.body || {};
  if (backendUrl) cfg.vsh.backendUrl = backendUrl.trim();
  if (lwaClientId) cfg.vsh.lwaClientId = lwaClientId.trim();
  persist();
  res.json({ ok: true });
});

app.post('/api/vsh/link/start', async (req, res) => {
  try {
    const linking = await vsh.startLinking();
    res.json({ ok: true, linking });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/vsh/link/status', (req, res) => {
  res.json(vsh.getStatus());
});

app.post('/api/vsh/link/cancel', (req, res) => {
  vsh.cancelLinking();
  res.json({ ok: true });
});

app.post('/api/vsh/unlink', async (req, res) => {
  await vsh.unlink();
  res.json({ ok: true });
});

app.post('/api/vsh/test-token', async (req, res) => {
  try {
    const result = await vsh.testToken();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
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

app.listen(PORT, () => {
  console.log(`DomLink läuft auf Port ${PORT}`);

  pollDomoticz();
  setInterval(pollDomoticz, POLL_INTERVAL_MS);

  if (vsh.isLinked()) {
    vsh.connect().catch((err) => console.error('VSH: Verbindung beim Start fehlgeschlagen:', err.message));
  }
});

process.on('SIGTERM', async () => {
  await vsh.disconnect();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await vsh.disconnect();
  process.exit(0);
});
