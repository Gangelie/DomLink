const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 15;

function defaultConfig() {
  return {
    passwordHash: bcrypt.hashSync('admin', 10),
    mustChangePassword: true,
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    domoticz: {
      url: '',
      port: '',
      username: '',
      password: '',
    },
    vsh: {
      backendUrl: 'https://kfd5m4a21f.execute-api.eu-west-1.amazonaws.com/dev',
      lwaClientId: 'amzn1.application-oa2-client.3f1bb07133854b078261ad43f2484c18',
      credentials: null, // { thingId, cert, privateKey, caCert, server, port, vshJwt, email, refreshToken, accessToken, accessTokenExpiry }
    },
    devices: {}, // idx -> { active, alexaName, alexaType }
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    save(cfg);
    return cfg;
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const cfg = Object.assign(defaultConfig(), parsed);
    cfg.domoticz = Object.assign(defaultConfig().domoticz, parsed.domoticz || {});
    cfg.vsh = Object.assign(defaultConfig().vsh, parsed.vsh || {});
    cfg.devices = parsed.devices || {};
    return cfg;
  } catch (err) {
    console.error('Konnte config.json nicht lesen, verwende Standardkonfiguration:', err.message);
    const cfg = defaultConfig();
    save(cfg);
    return cfg;
  }
}

// Keep a rolling history of previous config versions so an accidental
// overwrite/delete of config.json is never a total loss - each save snapshots
// the state that's about to be replaced before writing the new one.
function backupCurrentConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return;

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(CONFIG_PATH, path.join(BACKUP_DIR, `config-${stamp}.json`));

  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('config-') && f.endsWith('.json'))
    .sort();
  while (files.length > MAX_BACKUPS) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
}

function save(cfg) {
  ensureDataDir();
  try {
    backupCurrentConfig();
  } catch (err) {
    console.error('Konnte kein Backup von config.json erstellen:', err.message);
  }
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf-8');
  fs.renameSync(tmpPath, CONFIG_PATH);
}

module.exports = { load, save, DATA_DIR, CONFIG_PATH };
