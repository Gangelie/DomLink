const EventEmitter = require('events');
const axios = require('axios');
const mqtt = require('mqtt');
const { buildPropertiesFromState, annotateChanges } = require('./deviceTypes');

const VSH_VERSION = '4.0.0';
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const LWA_CODEPAIR_URL = 'https://api.amazon.com/auth/o2/create/codepair';

function decodeBase64(str) {
  return Buffer.from(str, 'base64').toString('utf-8');
}

// Native re-implementation of the Virtual Smart Home (VSH) cloud protocol,
// reverse engineered from the open-source node-red-contrib-virtual-smart-home
// package (MIT licensed) so it can run standalone, without Node-RED.
//
// Two phases:
//  1) One-time linking via Amazon's LWA "device code" OAuth flow, followed by
//     provisioning against the VSH backend to obtain AWS IoT (MQTT/mTLS) credentials.
//  2) An ongoing MQTT connection used to receive Alexa directives and publish
//     device discovery / state (ChangeReport, StateReport).
class VshBridge extends EventEmitter {
  constructor({ cfg, persist, deviceStore, logger = console }) {
    super();
    this.cfg = cfg;
    this.persist = persist;
    this.deviceStore = deviceStore;
    this.logger = logger;

    this.client = null;
    this.isSubscribed = false;
    this.userIdToken = '';
    this.plan = 'unbekannt';
    this.linking = null;

    this.deviceStore.on('change', (changes) => this._onDomoticzChanges(changes));
    this.deviceStore.on('config-changed', () => {
      this.syncDiscovery().catch((e) => this.logger.warn('VSH: syncDiscovery fehlgeschlagen:', e.message));
    });
  }

  // ---------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------

  isLinked() {
    return !!(this.cfg.vsh.credentials && this.cfg.vsh.credentials.thingId);
  }

  isConnected() {
    return !!(this.client && this.client.connected);
  }

  getStatus() {
    const creds = this.cfg.vsh.credentials;
    return {
      linked: this.isLinked(),
      connected: this.isConnected(),
      email: creds ? creds.email : null,
      plan: this.plan,
      linking: this.linking
        ? {
            status: this.linking.status,
            userCode: this.linking.userCode,
            verificationUri: this.linking.verificationUri,
            error: this.linking.error,
            expiresAt: this.linking.expiresAt,
          }
        : null,
    };
  }

  // ---------------------------------------------------------------------
  // Amazon LWA device-code linking flow
  // ---------------------------------------------------------------------

  async startLinking() {
    if (this.linking && this.linking.status === 'pending') {
      return this.getStatus().linking;
    }

    const backendUrl = this.cfg.vsh.backendUrl;
    const lwaClientId = this.cfg.vsh.lwaClientId;

    if (!backendUrl || !lwaClientId) {
      throw new Error('VSH Backend-URL / LWA Client-ID ist nicht konfiguriert');
    }

    try {
      const versionCheck = await axios
        .get(`${backendUrl}/check_version`, { params: { version: VSH_VERSION }, timeout: 10000 })
        .then((r) => r.data);
      if (versionCheck && versionCheck.isAllowedVersion === false) {
        throw new Error(versionCheck.updateHint || 'VSH-Backend hat die Verbindung abgelehnt');
      }
    } catch (err) {
      if (err.response === undefined && err.message && err.message.includes('VSH-Backend')) throw err;
      // Non-fatal: backend reachability issues for the version check shouldn't block linking.
      this.logger.warn('VSH: Versionsprüfung fehlgeschlagen (wird ignoriert):', err.message);
    }

    const codePairResp = await axios
      .post(
        LWA_CODEPAIR_URL,
        { response_type: 'device_code', client_id: lwaClientId, scope: 'profile' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      )
      .then((r) => r.data);

    if (codePairResp.error_description) {
      throw new Error(codePairResp.error_description);
    }

    const { device_code, user_code, verification_uri, expires_in, interval } = codePairResp;

    this.linking = {
      status: 'pending',
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      expiresAt: Date.now() + expires_in * 1000,
      interval: interval || 5,
      error: null,
      timer: null,
    };

    this._pollLinking(this.linking);

    return this.getStatus().linking;
  }

  _pollLinking(session) {
    session.timer = setTimeout(async () => {
      if (this.linking !== session) return; // superseded by a newer linking attempt

      if (Date.now() > session.expiresAt) {
        session.status = 'error';
        session.error = 'Code abgelaufen. Bitte erneut starten.';
        return;
      }

      try {
        const tokenResp = await axios
          .post(
            LWA_TOKEN_URL,
            { grant_type: 'device_code', device_code: session.deviceCode, user_code: session.userCode },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
          )
          .then((r) => r.data);

        if (tokenResp.error === 'authorization_pending') {
          return this._pollLinking(session);
        }

        if (tokenResp.error) {
          session.status = 'error';
          session.error = tokenResp.error_description || tokenResp.error;
          return;
        }

        const provisionData = await axios
          .post(
            `${this.cfg.vsh.backendUrl}/provision`,
            { accessToken: tokenResp.access_token, vshVersion: VSH_VERSION },
            { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
          )
          .then((r) => r.data);

        if (provisionData.error) {
          session.status = 'error';
          session.error = provisionData.error;
          return;
        }

        this.cfg.vsh.credentials = {
          thingId: provisionData.thingId,
          cert: provisionData.cert,
          privateKey: provisionData.privateKey,
          caCert: provisionData.caCert,
          server: provisionData.server,
          port: provisionData.port,
          vshJwt: provisionData.vshJwt,
          email: provisionData.email,
          refreshToken: tokenResp.refresh_token,
          accessToken: tokenResp.access_token,
          accessTokenExpiry: Date.now() + (tokenResp.expires_in - 15) * 1000,
        };
        this.persist();

        session.status = 'success';
        this.linking = null;

        this.connect().catch((e) => this.logger.error('VSH: Verbindung nach Provisionierung fehlgeschlagen:', e.message));
      } catch (err) {
        session.status = 'error';
        session.error = (err.response && err.response.data && err.response.data.error_description) || err.message;
      }
    }, session.interval * 1000);
  }

  cancelLinking() {
    if (this.linking && this.linking.timer) clearTimeout(this.linking.timer);
    this.linking = null;
  }

  async unlink() {
    await this.disconnect();
    this.cfg.vsh.credentials = null;
    this.persist();
  }

  async testToken() {
    const creds = this.cfg.vsh.credentials;
    if (!creds || !creds.vshJwt) throw new Error('Nicht mit VSH verbunden');
    const resp = await axios.get(`${this.cfg.vsh.backendUrl}/plan`, {
      headers: { Authorization: `Bearer ${creds.vshJwt}` },
      timeout: 10000,
    });
    if (resp.data.plan) this.plan = resp.data.plan;
    return resp.data;
  }

  // ---------------------------------------------------------------------
  // MQTT (AWS IoT) connection
  // ---------------------------------------------------------------------

  async connect() {
    const creds = this.cfg.vsh.credentials;
    if (!creds || !creds.server) return;

    if (this.client) {
      await this.disconnect();
    }

    const options = {
      clientId: creds.thingId,
      key: decodeBase64(creds.privateKey),
      cert: decodeBase64(creds.cert),
      ca: decodeBase64(creds.caCert),
      protocolVersion: 5,
      reconnectPeriod: 60000,
      connectTimeout: 30000,
      keepalive: 90,
      rejectUnauthorized: true,
      resubscribe: false,
      clean: true,
      will: {
        topic: `vsh/${creds.thingId}/update`,
        payload: JSON.stringify({ state: { reported: { connected: false } } }),
        qos: 1,
      },
    };

    const url = `mqtts://${creds.server}:${creds.port}`;
    this.logger.log(`VSH: verbinde mit ${creds.server}:${creds.port} ...`);

    this.client = mqtt.connect(url, options);
    this.client.on('connect', () => this._onConnect());
    this.client.on('message', (topic, message) => this._onMessage(topic, message));
    this.client.on('error', (err) => this.logger.error('VSH MQTT Fehler:', err.message));
    this.client.on('close', () => {
      this.isSubscribed = false;
    });
  }

  _onConnect() {
    const creds = this.cfg.vsh.credentials;
    this.logger.log('VSH: MQTT verbunden');

    const topics = [
      `$aws/things/${creds.thingId}/shadow/get/accepted`,
      `vsh/${creds.thingId}/+/directive`,
      `vsh/service`,
      `vsh/${creds.thingId}/service`,
    ];

    this.client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        this.logger.error('VSH: Subscribe fehlgeschlagen:', err.message);
        return;
      }
      this.isSubscribed = true;
      this._publish(`$aws/things/${creds.thingId}/shadow/update`, {
        state: { reported: { connected: true, vsh_version: VSH_VERSION } },
      });
      this._publish(`vsh/${creds.thingId}/requestConfig`, { vshVersion: VSH_VERSION });
    });
  }

  _publish(topic, payload) {
    if (!this.client) return;
    this.client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) this.logger.error(`VSH: Publish auf ${topic} fehlgeschlagen:`, err.message);
    });
  }

  _onMessage(topic, messageBuf) {
    let message;
    try {
      message = JSON.parse(messageBuf.toString());
    } catch (e) {
      return;
    }

    const creds = this.cfg.vsh.credentials;
    if (!creds) return;

    if (topic === `$aws/things/${creds.thingId}/shadow/get/accepted`) {
      return this._handleGetAccepted(message);
    }
    if (topic === 'vsh/service' || topic === `vsh/${creds.thingId}/service`) {
      return this._handleService(message);
    }

    const match = topic.match(/vshd-[^/]+/);
    if (match && topic.includes('/directive') && message.directive && message.directive.header) {
      return this._handleDirective(match[0], message);
    }
  }

  _handleService(message) {
    const creds = this.cfg.vsh.credentials;
    switch (message.operation) {
      case 'ping':
        return this._publish(`vsh/${creds.thingId}/pong`, {
          thingId: creds.thingId,
          email: creds.email,
          vsh_version: VSH_VERSION,
        });
      case 'overrideConfig':
        if (message.userIdToken) this.userIdToken = message.userIdToken;
        if (message.plan) this.plan = message.plan;
        return this._publish(`$aws/things/${creds.thingId}/shadow/get`, {});
      case 'restart':
        this.logger.warn('VSH: Neustart der Verbindung angefordert');
        return this.disconnect().then(() => this.connect());
      case 'kill':
        this.logger.error('VSH: Verbindung serverseitig beendet:', message.reason || '');
        return this.disconnect();
      default:
        return;
    }
  }

  _handleGetAccepted(message) {
    const shadowDevices = (message.state && message.state.reported && message.state.reported.devices) || {};
    const localDevices = {};
    for (const d of this.deviceStore.getActiveVshDevices()) {
      localDevices[d.deviceId] = d;
    }

    const toDiscover = {};
    for (const deviceId in localDevices) {
      const l = localDevices[deviceId];
      const s = shadowDevices[deviceId];
      if (!s || s.template !== l.template || s.friendlyName !== l.friendlyName || s.retrievable !== l.retrievable) {
        toDiscover[deviceId] = l;
      }
    }

    const toUndiscover = {};
    for (const deviceId in shadowDevices) {
      if (!localDevices[deviceId]) {
        toUndiscover[deviceId] = shadowDevices[deviceId];
        toDiscover[deviceId] = null;
      }
    }

    const creds = this.cfg.vsh.credentials;
    if (Object.keys(toDiscover).length > 0) {
      this._publish(`$aws/things/${creds.thingId}/shadow/update`, { state: { reported: { devices: toDiscover } } });
      this._bulkDiscover(toDiscover, 'discover');
    }
    if (Object.keys(toUndiscover).length > 0) {
      this._bulkDiscover(toUndiscover, 'undiscover');
    }
  }

  _bulkDiscover(devices, mode) {
    const payload = { devices: [] };
    for (const deviceId in devices) {
      if (devices[deviceId] !== null) {
        const d = devices[deviceId];
        payload.devices.push({ deviceId, friendlyName: d.friendlyName, template: d.template, retrievable: d.retrievable });
      }
    }
    if (payload.devices.length > 0) {
      this._publish(`vsh/${this.cfg.vsh.credentials.thingId}/bulk${mode}`, payload);
    }
  }

  // Ask VSH to re-send its known device shadow so we can diff it against our
  // locally active devices (called after dashboard edits: active/name/type).
  async syncDiscovery() {
    if (!this.isConnected()) return;
    this._publish(`$aws/things/${this.cfg.vsh.credentials.thingId}/shadow/get`, {});
  }

  async _handleDirective(deviceId, directiveRequest) {
    const name = directiveRequest.directive.header.name;
    const correlationToken = directiveRequest.directive.header.correlationToken || '';
    const payload = directiveRequest.directive.payload || {};

    try {
      const { oldState, newState, template } = await this.deviceStore.applyDirective(deviceId, name, payload);
      const oldProps = buildPropertiesFromState(oldState);
      let newProps = buildPropertiesFromState(newState);
      newProps = annotateChanges(newProps, oldProps);

      this._triggerChangeReport({
        template,
        endpointId: deviceId,
        properties: newProps,
        causeType: name === 'ReportState' ? 'STATE_REPORT' : 'VOICE_INTERACTION',
        correlationToken,
      });
    } catch (err) {
      this.logger.error(`VSH: Direktive ${name} für ${deviceId} fehlgeschlagen:`, err.message);
    }
  }

  _onDomoticzChanges(changes) {
    for (const change of changes) {
      const oldProps = buildPropertiesFromState(change.oldState).map((p) => ({ ...p, changed: false }));
      let newProps = buildPropertiesFromState(change.newState);
      newProps = annotateChanges(newProps, oldProps);
      this._triggerChangeReport({
        template: change.template,
        endpointId: change.deviceId,
        properties: newProps,
        causeType: 'PHYSICAL_INTERACTION',
      });
    }
  }

  _triggerChangeReport({ template, endpointId, properties, causeType, correlationToken = '' }) {
    if (!this.isConnected()) return;
    const changed = properties.filter((p) => p.changed).length;
    if (changed === 0 && causeType === 'PHYSICAL_INTERACTION') return;

    this._publish(`vsh/${this.cfg.vsh.credentials.thingId}/changeReport`, {
      template,
      endpointId,
      properties,
      correlationToken,
      causeType,
      vshVersion: VSH_VERSION,
      userIdToken: this.userIdToken,
    });
  }

  async disconnect() {
    if (!this.client) return;
    const creds = this.cfg.vsh.credentials;
    try {
      if (this.isConnected() && creds) {
        this._publish(`$aws/things/${creds.thingId}/shadow/update`, { state: { reported: { connected: false } } });
      }
      await this.client.endAsync();
    } catch (e) {
      // ignore - we're tearing down anyway
    }
    this.client = null;
    this.isSubscribed = false;
  }
}

module.exports = VshBridge;
