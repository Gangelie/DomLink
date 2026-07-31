import { EventEmitter } from 'node:events';

// In-memory ring buffer + pub/sub for the live debug log shown in the
// dashboard's "Live-Protokoll" tab. Not persisted - purely a runtime
// debugging aid for seeing what Alexa/Matter commands arrive and what they
// trigger in Domoticz.

const MAX_ENTRIES = 500;
let nextId = 1;
const buffer = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function log(source, level, message, deviceName = null) {
  const entry = { id: nextId++, ts: Date.now(), source, level, deviceName, message };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  emitter.emit('entry', entry);
  return entry;
}

export function getBuffer() {
  return buffer.slice();
}

// Returns an unsubscribe function.
export function onEntry(listener) {
  emitter.on('entry', listener);
  return () => emitter.off('entry', listener);
}
