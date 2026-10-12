import axios from 'axios';

export default class DomoticzClient {
  constructor(getConfig) {
    // getConfig() returns the current { url, port, username, password } each call,
    // so live settings changes take effect without recreating the client.
    this.getConfig = getConfig;
  }

  _baseUrl() {
    const { url, port } = this.getConfig();
    if (!url) return null;
    const trimmed = url.replace(/\/+$/, '');
    return port ? `${trimmed}:${port}` : trimmed;
  }

  _axiosConfig() {
    const { username, password } = this.getConfig();
    const opts = { timeout: 8000 };
    if (username) {
      opts.auth = { username, password: password || '' };
    }
    return opts;
  }

  async _get(params) {
    const base = this._baseUrl();
    if (!base) throw new Error('Domoticz URL ist nicht konfiguriert');
    const resp = await axios.get(`${base}/json.htm`, {
      ...this._axiosConfig(),
      params,
    });
    if (resp.data && resp.data.status && resp.data.status !== 'OK') {
      throw new Error(`Domoticz meldet Fehler: ${resp.data.status}`);
    }
    return resp.data;
  }

  async testConnection() {
    const data = await this._get({ type: 'command', param: 'getversion' });
    return { ok: true, version: data.version || data.dzvents_version || 'unbekannt' };
  }

  async getDevices() {
    const data = await this._get({
      type: 'command',
      param: 'getdevices',
      filter: 'all',
      used: 'true',
    });
    return data.result || [];
  }

  async getDevice(idx) {
    const data = await this._get({ type: 'devices', rid: idx });
    return (data.result && data.result[0]) || null;
  }

  async switchLight(idx, cmd) {
    return this._get({
      type: 'command',
      param: 'switchlight',
      idx,
      switchcmd: cmd,
    });
  }

  // Scenes and groups use a distinct Domoticz API endpoint.
  async switchScene(idx, cmd) {
    return this._get({
      type: 'command',
      param: 'switchscene',
      idx,
      switchcmd: cmd,
    });
  }

  async setLevel(idx, level) {
    return this._get({
      type: 'command',
      param: 'switchlight',
      idx,
      switchcmd: 'Set Level',
      level: Math.max(0, Math.min(100, Math.round(level))),
    });
  }

  async setSetpoint(idx, setpoint) {
    return this._get({
      type: 'command',
      param: 'setsetpoint',
      idx,
      setpoint,
    });
  }
}
