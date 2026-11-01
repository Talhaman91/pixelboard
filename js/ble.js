// Web-Bluetooth-Transport fürs iPixel-Board (entspricht send_plan/AckManager aus pypixelcolor).
import { WRITE_UUID, NOTIFY_UUID, classifyAck, deviceInfoCommand, parseDeviceInfo } from "./protocol.js";

// Die App kennt nur die Charakteristiken (fa02/fa03). Web Bluetooth verlangt aber, dass
// der Dienst vorher freigegeben wird – daher eine Liste üblicher Kandidaten.
export const SERVICE_CANDIDATES = [
  0xfa00, 0xae00, 0xffe0, 0xfee7, 0xfff0, 0xffd0, 0x00ff, 0xff00, 0x1910, 0xfe00,
];

const ACK_TIMEOUT = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Board extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.write = null;
    this.notify = null;
    this.info = null;
    this.chunkSize = 244;
    this.idleMinutes = 3;
    this._chain = Promise.resolve();
    this._idleTimer = null;
    this._acks = { window: false, final: false };
    this._waiters = [];
    this._capture = null;
    this._onNotify = this._onNotify.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
  }

  static get supported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  get connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected && this.write);
  }

  _emit() {
    this.dispatchEvent(new Event("change"));
  }

  // Muss aus einem Klick heraus aufgerufen werden (Browser-Vorgabe).
  async choose({ acceptAll = false, extraServices = [] } = {}) {
    if (!Board.supported) throw new Error("Web Bluetooth wird von diesem Browser nicht unterstützt (Chrome nutzen).");
    const optionalServices = [...SERVICE_CANDIDATES, ...extraServices];
    const device = await navigator.bluetooth.requestDevice(
      acceptAll
        ? { acceptAllDevices: true, optionalServices }
        : { filters: [{ namePrefix: "LED_BLE" }, { namePrefix: "LED" }], optionalServices },
    );
    await this._attach(device);
    return device;
  }

  // Bereits freigegebenes Gerät ohne Auswahldialog wiederfinden (falls der Browser es kann).
  async restore() {
    if (!Board.supported || !navigator.bluetooth.getDevices) return false;
    const devices = await navigator.bluetooth.getDevices();
    const dev = devices.find((d) => (d.name || "").startsWith("LED")) || devices[0];
    if (!dev) return false;
    this._setDevice(dev);
    this._emit();
    return true;
  }

  _setDevice(device) {
    if (this.device && this.device !== device) {
      this.device.removeEventListener("gattserverdisconnected", this._onDisconnect);
    }
    this.device = device;
    device.addEventListener("gattserverdisconnected", this._onDisconnect);
  }

  async _attach(device) {
    this._setDevice(device);
    await this._connectGatt();
  }

  async _connectGatt() {
    if (!this.device) throw new Error("Kein Board ausgewählt");
    const server = await this.device.gatt.connect();
    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch {
      for (const uuid of SERVICE_CANDIDATES) {
        try { services.push(await server.getPrimaryService(uuid)); } catch { /* weiter */ }
      }
    }
    let write = null, notify = null;
    for (const s of services) {
      try { write = await s.getCharacteristic(WRITE_UUID); } catch { continue; }
      try { notify = await s.getCharacteristic(NOTIFY_UUID); } catch { /* evtl. anderer Dienst */ }
      break;
    }
    if (!notify) {
      for (const s of services) {
        try { notify = await s.getCharacteristic(NOTIFY_UUID); break; } catch { /* weiter */ }
      }
    }
    if (!write) {
      const found = services.map((s) => s.uuid).join(", ") || "keine";
      this.device.gatt.disconnect();
      throw new Error(`Schreib-Charakteristik fa02 nicht gefunden. Freigegebene Dienste: ${found}`);
    }
    this.write = write;
    this.notify = notify;
    if (notify) {
      notify.addEventListener("characteristicvaluechanged", this._onNotify);
      await notify.startNotifications();
    }
    const resp = await this._sendPlanNow(deviceInfoCommand());
    try {
      this.info = parseDeviceInfo(resp);
    } catch {
      this.info = this.info || { width: 32, height: 32, ledType: 2 };
    }
    this._touch();
    this._emit();
  }

  _onDisconnect() {
    this.write = null;
    this.notify = null;
    this._rejectWaiters(new Error("Verbindung getrennt"));
    this._emit();
  }

  _onNotify(ev) {
    const v = ev.target.value;
    const data = new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
    if (this._capture) {
      const cap = this._capture;
      this._capture = null;
      cap(data);
      return;
    }
    const kind = classifyAck(data);
    if (kind === "window") this._acks.window = true;
    if (kind === "final") { this._acks.window = true; this._acks.final = true; }
    this._waiters = this._waiters.filter((w) => {
      if (this._acks[w.kind]) { w.resolve(); return false; }
      return true;
    });
  }

  _rejectWaiters(err) {
    for (const w of this._waiters) w.reject(err);
    this._waiters = [];
    if (this._capture) { const c = this._capture; this._capture = null; c(null); }
  }

  _waitAck(kind) {
    if (this._acks[kind]) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { kind, resolve, reject };
      this._waiters.push(w);
      setTimeout(() => {
        if (this._waiters.includes(w)) {
          this._waiters = this._waiters.filter((x) => x !== w);
          reject(new Error("Keine Bestätigung vom Board (Timeout)"));
        }
      }, ACK_TIMEOUT);
    });
  }

  async _writeChunk(chunk) {
    if (this.write.writeValueWithResponse) await this.write.writeValueWithResponse(chunk);
    else await this.write.writeValue(chunk);
  }

  async _sendPlanNow(plan, onProgress) {
    let response = null;
    let responsePromise = null;
    if (plan.expectResponse) {
      responsePromise = new Promise((resolve) => {
        this._capture = resolve;
        setTimeout(() => { if (this._capture === resolve) { this._capture = null; resolve(null); } }, ACK_TIMEOUT);
      });
    }
    const total = plan.windows.reduce((n, w) => n + w.data.length, 0);
    let sent = 0;
    for (const win of plan.windows) {
      this._acks.window = false;
      this._acks.final = false;
      for (let pos = 0; pos < win.data.length; pos += this.chunkSize) {
        const chunk = win.data.subarray(pos, Math.min(pos + this.chunkSize, win.data.length));
        await this._writeChunk(chunk);
        sent += chunk.length;
        if (onProgress) onProgress(sent / total);
      }
      if (plan.ackPerWindow && win.requiresAck && this.notify) await this._waitAck("window");
    }
    if (plan.ackFinal && this.notify) await this._waitAck("final");
    if (responsePromise) {
      response = await responsePromise;
      if (!response) throw new Error("Keine Antwort vom Board");
    }
    return response;
  }

  // Plan senden – nacheinander, mit automatischem Wiederverbinden.
  send(plan, onProgress) {
    const run = async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (!this.connected) await this._connectGatt();
          const r = await this._sendPlanNow(plan, onProgress);
          this._touch();
          return r;
        } catch (e) {
          if (attempt === 2 || e.name === "NotFoundError") throw e;
          try { this.device?.gatt?.disconnect(); } catch { /* egal */ }
          await sleep(400);
        }
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async connect() {
    if (!this.connected) await this._connectGatt();
  }

  disconnect() {
    clearTimeout(this._idleTimer);
    try { this.device?.gatt?.disconnect(); } catch { /* egal */ }
    this._onDisconnect();
  }

  _touch() {
    clearTimeout(this._idleTimer);
    if (this.idleMinutes > 0) {
      this._idleTimer = setTimeout(() => this.disconnect(), this.idleMinutes * 60000);
    }
  }
}
