// Fuses Wi-Fi fixes (low rate, absolute) with PDR deltas (high rate, relative)
// using a lightweight complementary filter. Good enough for corridor-scale UX.

import { WifiPositioning } from "./wifiPositioning.js";
import { PedestrianDeadReckoning } from "./pedestrianDeadReckoning.js";

const WIFI_TRUST = 0.35;          // how much each Wi-Fi fix pulls the fused state
const WIFI_MAX_JUMP_M = 15;       // ignore Wi-Fi fixes farther than this from PDR
const STALE_PDR_MS = 2000;        // if no PDR for this long, Wi-Fi fully overrides

export class IndoorLocationManager {
  constructor({ apTable, pdrOptions } = {}) {
    this.wifi = new WifiPositioning(apTable || []);
    this.pdr = new PedestrianDeadReckoning(pdrOptions);
    this.state = { x: 0, y: 0, floor: undefined, accuracy: Infinity };
    this._lastPdrAt = 0;
    this.listeners = new Set();

    // Bridge PDR → fused state
    this.pdr.onState(({ x, y, heading }) => {
      this.state.heading = heading;
      // PDR is relative; consume the delta and apply to fused position
      const dx = x - this._pdrBaselineX;
      const dy = y - this._pdrBaselineY;
      this._pdrBaselineX = x;
      this._pdrBaselineY = y;
      this.state.x += dx;
      this.state.y += dy;
      this._lastPdrAt = Date.now();
      this._emit();
    });
    this._pdrBaselineX = 0;
    this._pdrBaselineY = 0;
  }

  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn({ ...this.state }); }

  /** Call when a Wi-Fi scan finishes. scans: [{bssid, rssi}] */
  onWifiScan(scans) {
    const fix = this.wifi.estimate(scans);
    if (!fix) return;

    const stale = Date.now() - this._lastPdrAt > STALE_PDR_MS;
    const dist = Math.hypot(fix.x - this.state.x, fix.y - this.state.y);

    if (stale || this.state.accuracy === Infinity || dist > WIFI_MAX_JUMP_M) {
      // Snap
      this.state.x = fix.x;
      this.state.y = fix.y;
    } else {
      // Blend
      this.state.x = this.state.x * (1 - WIFI_TRUST) + fix.x * WIFI_TRUST;
      this.state.y = this.state.y * (1 - WIFI_TRUST) + fix.y * WIFI_TRUST;
    }
    this.state.floor = fix.floor ?? this.state.floor;
    this.state.accuracy = fix.accuracy;
    this._emit();
  }

  /** Accelerometer magnitude sample from native bridge */
  onAccel(mag, tMs = Date.now()) { this.pdr.ingestAccelSample(mag, tMs); }

  /** Absolute heading in radians (rotation-vector fused) */
  onHeading(headingRad) { this.pdr.ingestHeading(headingRad); }
}
