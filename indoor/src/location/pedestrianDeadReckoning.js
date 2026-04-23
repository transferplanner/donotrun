// Pedestrian Dead Reckoning: step detection on linear-acceleration magnitude +
// heading integration from gyroscope (rotation-vector preferred).

const STEP_THRESHOLD = 1.1;   // m/s^2 above gravity-stripped baseline
const STEP_MIN_INTERVAL_MS = 280;
const DEFAULT_STEP_LENGTH_M = 0.72;

export class PedestrianDeadReckoning {
  constructor({ stepLength = DEFAULT_STEP_LENGTH_M } = {}) {
    this.stepLength = stepLength;
    this.heading = 0;          // radians, CCW from +x (east)
    this.x = 0;
    this.y = 0;
    this._lastStepAt = 0;
    this._accelPrev = 0;
    this._peakArmed = false;
    this.listeners = new Set();
  }

  reset(x = 0, y = 0, headingRad = 0) {
    this.x = x;
    this.y = y;
    this.heading = headingRad;
  }

  onState(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn({ x: this.x, y: this.y, heading: this.heading }); }

  /** linear-acceleration magnitude samples (gravity removed) */
  ingestAccelSample(mag, tMs) {
    // Simple peak detection with refractory period
    if (mag > STEP_THRESHOLD && this._accelPrev <= STEP_THRESHOLD) {
      this._peakArmed = true;
    }
    if (this._peakArmed && mag < this._accelPrev && this._accelPrev > STEP_THRESHOLD) {
      if (tMs - this._lastStepAt > STEP_MIN_INTERVAL_MS) {
        this._lastStepAt = tMs;
        this._peakArmed = false;
        this._advanceStep();
      }
    }
    this._accelPrev = mag;
  }

  /** Absolute heading in radians from device sensors (rotation-vector / magnetometer-fused). */
  ingestHeading(headingRad) {
    this.heading = headingRad;
  }

  _advanceStep() {
    this.x += this.stepLength * Math.cos(this.heading);
    this.y += this.stepLength * Math.sin(this.heading);
    this._emit();
  }
}
