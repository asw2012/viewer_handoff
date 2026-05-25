/**
 * workpiece_sim.js — 3D stock-removal simulation for NC verification.
 *
 * Pure visualization module.  Does NOT modify any solver, viewer, or config code.
 * The workpiece is represented as a cylindrical radial heightmap.
 * Each NC frame's A-axis value gives the angular position of the cut on the
 * workpiece, and the Y-axis value maps to the axial position.
 * Cross-section profiles use a flat-plane model: the grinding wheel is
 * approximated as a flat plane perpendicular to the radial direction at
 * the contact angle, cutting to the specified depth.
 */

import * as THREE from "three";

const DEG2RAD = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/* ------------------------------------------------------------------ */
/*  NC section parsing                                                 */
/* ------------------------------------------------------------------ */

/**
 * Extract operation section boundaries from raw NC text.
 * Looks for comment markers like:
 *   ; BEGIN FLUTE 1 GRIND  /  ; END FLUTE 1 GRIND
 *   ( BEGIN FLUTE 1 )      /  ( END FLUTE 1 )
 * @param {string} ncText  Raw NC file content
 * @returns {{ label: string, beginLine: number, endLine: number }[]}
 */
export function parseNcSections(ncText) {
  const lines = ncText.split(/\r?\n/);
  const sections = [];
  const open = {};
  for (let i = 0; i < lines.length; i++) {
    const upper = lines[i].toUpperCase();
    // Match parenthesized: ( BEGIN FLUTE 1 )
    // Match semicolon:     ; BEGIN FLUTE 1 GRIND
    const bm =
      upper.match(/\(\s*BEGIN\s+(.+?)\s*\)/) ||
      upper.match(/;\s*BEGIN\s+(.+)/);
    if (bm) {
      // Normalize: strip trailing "GRIND" and whitespace
      const rawLabel = bm[1].trim().replace(/\s+GRIND\s*$/, "").trim();
      if (rawLabel) {
        open[rawLabel] = { label: rawLabel, beginLine: i + 1 };
      }
    }
    const em =
      upper.match(/\(\s*END\s+(.+?)\s*\)/) ||
      upper.match(/;\s*END\s+(.+)/);
    if (em) {
      const rawLabel = em[1].trim().replace(/\s+GRIND\s*$/, "").trim();
      if (open[rawLabel]) {
        sections.push({ ...open[rawLabel], endLine: i + 1 });
        delete open[rawLabel];
      }
    }
  }
  return sections;
}

/**
 * Tag each viewer frame with its NC section label.
 * @param {object[]} frames   Output of viewer's parseNc()
 * @param {object[]} sections Output of parseNcSections()
 * @returns {object[]}  Frames with added `.section` property
 */
export function classifyFrames(frames, sections) {
  return frames.map((f) => {
    for (const s of sections) {
      if (f.line >= s.beginLine && f.line <= s.endLine) {
        return { ...f, section: s.label };
      }
    }
    return { ...f, section: null };
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function opInfo(sectionLabel) {
  if (!sectionLabel) return null;
  const u = sectionLabel.toUpperCase();
  if (u.includes("FLUTE")) {
    const m = u.match(/FLUTE\s*(\d+)/);
    return { type: "flute", index: m ? Number(m[1]) : 1 };
  }
  if (u.includes("OD RELIEF")) {
    const m = u.match(/OD\s*RELIEF\s*(\d+)/);
    return { type: "od_relief", index: m ? Number(m[1]) : 1 };
  }
  return null;
}

/** Wrap angle to [-PI, PI]. */
function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rayCylinderFirstHit(rayOrigin, rayDir, axisOrigin, axisDir, radius, halfWidth) {
  const v = rayOrigin.clone().sub(axisOrigin);
  const b = rayDir.dot(axisDir);
  const c0 = rayDir.dot(v);
  const d = axisDir.dot(v);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-9) return null;

  const rClosest = (b * d - c0) / denom;
  if (rClosest < 0) return null;

  const tClosest = d + b * rClosest;
  if (halfWidth > 0 && Math.abs(tClosest) > halfWidth) return null;

  const pClosest = v.clone()
    .add(rayDir.clone().multiplyScalar(rClosest))
    .sub(axisDir.clone().multiplyScalar(tClosest));
  const distSq = pClosest.lengthSq();
  const rSq = radius * radius;
  if (distSq >= rSq) return null;

  const offset = Math.sqrt(rSq - distSq);
  const rHit = rClosest - offset;
  if (rHit < 0) return 0;

  const tHit = d + b * rHit;
  if (halfWidth > 0 && Math.abs(tHit) > halfWidth) return null;

  return rHit;
}

function radiusAtAxialT(radius, halfWidth, cornerRadius, tAbs) {
  if (!(radius > 0) || !(halfWidth > 0)) return radius;
  if (!(cornerRadius > 0)) return radius;

  const innerHalf = Math.max(0, halfWidth - cornerRadius);
  if (tAbs <= innerHalf) return radius;
  if (tAbs > halfWidth) return 0;

  const u = tAbs - innerHalf;
  const base = radius - cornerRadius;
  const cap = Math.sqrt(Math.max(0, cornerRadius * cornerRadius - u * u));
  return base + cap;
}

function rayWheelProfileFirstHit(rayOrigin, rayDir, axisOrigin, axisDir, radius, halfWidth, cornerRadius) {
  const v = rayOrigin.clone().sub(axisOrigin);
  const b = rayDir.dot(axisDir);
  const c0 = rayDir.dot(v);
  const d = axisDir.dot(v);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-9) return null;

  const rClosest = (b * d - c0) / denom;
  if (rClosest < 0) return null;

  const tClosest = d + b * rClosest;
  const tAbs = Math.abs(tClosest);
  if (halfWidth > 0 && tAbs > halfWidth) return null;

  const pClosest = v.clone()
    .add(rayDir.clone().multiplyScalar(rClosest))
    .sub(axisDir.clone().multiplyScalar(tClosest));
  const axisDistSq = pClosest.lengthSq();

  const rEff = radiusAtAxialT(radius, halfWidth, cornerRadius, tAbs);
  const rEffSq = rEff * rEff;
  if (rEffSq <= 0 || axisDistSq >= rEffSq) return null;

  const offset = Math.sqrt(rEffSq - axisDistSq);
  const rHit = rClosest - offset;
  if (rHit < 0) return 0;
  return rHit;
}

/* ------------------------------------------------------------------ */
/*  WorkpieceSim                                                       */
/* ------------------------------------------------------------------ */

export class WorkpieceSim {
  /**
   * @param {object} cfg
   * @param {number} cfg.blankRadius         Blank radius (mm)
   * @param {number} cfg.blankLength         Blank length from chuck face to tip (mm)
   * @param {number} cfg.toolRadius          Nominal tool radius (mm)
   * @param {number} cfg.fluteDepthMm        Flute groove depth (mm)
   * @param {number} cfg.facetAngleDeg       OD-relief facet angle (deg)
   * @param {number} cfg.fluteLength         Flute operation length (mm)
   * @param {number} cfg.odReliefLength      OD-relief operation length (mm)
   * @param {number} cfg.fluteWheelRadius    Effective radius of the flute grinding wheel (mm)
   * @param {number} [cfg.fluteWheelWidthMm] Width of the 1A1 flute wheel (mm, default 12)
   * @param {number} [cfg.odWheelWidthMm]    Active face of the 11V9 OD wheel (mm, default 25)
  * @param {number} [cfg.wheel1RadiusMm]    OD wheel radius (mm)
  * @param {number} [cfg.wheel1WidthMm]     OD wheel active width (mm)
  * @param {number} [cfg.wheel2RadiusMm]    Flute wheel radius (mm)
  * @param {number} [cfg.wheel2WidthMm]     Flute wheel width (mm)
  * @param {number} [cfg.wheel2ODMm]        Flute wheel OD (mm)
  * @param {number} [cfg.wheel2CornerRadiusMm]
  * @param {number} [cfg.wheel2ShellThicknessMm]
  * @param {object} [cfg.axisDirections]    Machine axis directions {x,y,z,a}
  * @param {object} [cfg.axisOffsets]       Machine axis offsets {x,y,z}
  * @param {object} [cfg.axisSigns]         Machine axis signs {x,y,z}
  * @param {THREE.Vector3} [cfg.spindleAxisDir] Spindle axis direction in machine coords
  * @param {THREE.Vector3} [cfg.spindleOriginMachine] Spindle local origin in machine coords
  * @param {THREE.Quaternion} [cfg.simToMachineQuat] Sim-local to machine rotation
  * @param {THREE.Vector3} [cfg.simToMachinePos] Sim-local origin in machine coords
  * @param {string} [cfg.wheel1GrindSide]
  * @param {string} [cfg.wheel2GrindSide]
  * @param {number} [cfg.wheel1YOffsetMm]
  * @param {number} [cfg.wheel2YOffsetMm]
  * @param {number} [cfg.flute1WheelOffsetAngleDeg]
  * @param {number} [cfg.flute2WheelOffsetAngleDeg]
  * @param {boolean} [cfg.useWheelheadYZOnly] When true, ignore X for wheel center
  * @param {number} [cfg.nz=300]            Axial resolution
  * @param {number} [cfg.ntheta=540]        Angular resolution (cells around circumference)
   */
  constructor(cfg) {
    this.blankRadius = cfg.blankRadius;
    this.blankLength = cfg.blankLength;
    this.toolRadius = cfg.toolRadius;
    this.fluteDepthMm = cfg.fluteDepthMm;
    this.facetAngleDeg = cfg.facetAngleDeg;
    this.infeedMm =
      cfg.toolRadius * (1 - Math.cos(cfg.facetAngleDeg * DEG2RAD));
    this.fluteLength = cfg.fluteLength;
    this.odReliefLength = cfg.odReliefLength;
    this.fluteWheelRadius = cfg.fluteWheelRadius ?? 62.3;
    this.fluteWheelWidthMm = cfg.fluteWheelWidthMm ?? 12;
    this.odWheelWidthMm = cfg.odWheelWidthMm ?? 25;
    this.wheel1RadiusMm = cfg.wheel1RadiusMm ?? (cfg.wheel1ODMm ? cfg.wheel1ODMm / 2 : 55);
    this.wheel1WidthMm = cfg.wheel1WidthMm ?? this.odWheelWidthMm;
    this.wheel2RadiusMm = cfg.wheel2RadiusMm ?? this.fluteWheelRadius;
    this.wheel2WidthMm = cfg.wheel2WidthMm ?? this.fluteWheelWidthMm;
    this.wheel2ODMm = Number.isFinite(cfg.wheel2ODMm)
      ? cfg.wheel2ODMm
      : (Number.isFinite(cfg.wheel2RadiusMm) ? cfg.wheel2RadiusMm * 2 : null);
    this.wheel2CornerRadiusMm = Number.isFinite(cfg.wheel2CornerRadiusMm)
      ? cfg.wheel2CornerRadiusMm
      : 0;
    this.wheel2ShellThicknessMm = Number.isFinite(cfg.wheel2ShellThicknessMm)
      ? cfg.wheel2ShellThicknessMm
      : null;

    this.lastDebug = null;
    this.axisDirections = cfg.axisDirections || {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
      a: new THREE.Vector3(1, 0, 0),
      c: new THREE.Vector3(0, 0, -1),
    };
    this.axisOffsets = cfg.axisOffsets || { x: 0, y: 0, z: 0, a: 0, c: 0 };
    this.axisSigns = cfg.axisSigns || { x: 1, y: 1, z: 1, a: 1, c: 1 };
    this.spindleAxisDir = (cfg.spindleAxisDir || new THREE.Vector3(0, 1, 0))
      .clone()
      .normalize();
    this.spindleOriginMachine = (cfg.spindleOriginMachine || new THREE.Vector3()).clone();
    this.simToMachineQuat = (cfg.simToMachineQuat || new THREE.Quaternion()).clone();
    this.simToMachinePos = (cfg.simToMachinePos || new THREE.Vector3()).clone();
    this.machineToSimQuat = this.simToMachineQuat.clone().invert();
    this.aAxisPivot = (cfg.aAxisPivot || new THREE.Vector3()).clone();
    this.cAxisPivot = (cfg.cAxisPivot || new THREE.Vector3()).clone();
    this.wheel1GrindSide = String(cfg.wheel1GrindSide || "-y").trim().toLowerCase();
    this.wheel2GrindSide = String(cfg.wheel2GrindSide || "+y").trim().toLowerCase();
    this.wheel1YOffsetMm = Number.isFinite(cfg.wheel1YOffsetMm) ? cfg.wheel1YOffsetMm : 0;
    this.wheel2YOffsetMm = Number.isFinite(cfg.wheel2YOffsetMm) ? cfg.wheel2YOffsetMm : 0;
    this.flute1WheelOffsetAngleDeg = cfg.flute1WheelOffsetAngleDeg || 0;
    this.flute2WheelOffsetAngleDeg = cfg.flute2WheelOffsetAngleDeg || 0;
    this.useWheelheadYZOnly = cfg.useWheelheadYZOnly === true;

    this.nz = cfg.nz ?? 300;
    this.ntheta = cfg.ntheta ?? 540;
    this.dtheta = TWO_PI / this.ntheta;
    this.dz = this.blankLength / (this.nz - 1);

    this.lastStats = null;
    this.sweepSamples = [];
    this.captureSweepEvery = cfg.captureSweepEvery ?? 8;
    this.maxSweepSamples = cfg.maxSweepSamples ?? 120;
    this.enableVoxelCut = cfg.enableVoxelCut ?? true;
    this.lockSweepAxis = cfg.lockSweepAxis ?? false;
    this.sweepCenterOffset = cfg.sweepCenterOffset || new THREE.Vector3(0, 0, 0);
    this.useNcFrame = cfg.useNcFrame ?? false;

    /** @type {Float32Array[]} */
    this.heightmap = [];
    if (this.enableVoxelCut) {
      this.reset();
    }
  }

  /** Fill every cell with blankRadius. */
  reset() {
    this.heightmap = [];
    for (let iz = 0; iz < this.nz; iz++) {
      this.heightmap.push(
        new Float32Array(this.ntheta).fill(this.blankRadius)
      );
    }
  }

  /* ---- Core cut operations ---- */

  /**
   * Apply a wheel-arc cross-section cut at heightmap row `iz`.
   * Models the grinding wheel as a circle of radius `Rw` plunging into the
   * workpiece from the radial direction at angle `thetaCenterDeg`.
   *
   * The wheel center sits at distance D = (R − depth) + Rw from the
   * workpiece center along the radial direction.  For each angular
   * offset δ from centre the new workpiece radius is the nearer
   * intersection of the radial ray with the wheel circle:
   *
   *   r(δ) = D·cos(δ) − √(Rw² − D²·sin²(δ))
   *
   * This produces a concave groove matching the wheel's curvature —
   * the profile of a bottom-of-wheel flute grind.
   */
  _cutWheelArc(iz, thetaCenterDeg, depth, Rw) {
    if (iz < 0 || iz >= this.nz || depth <= 0 || Rw <= 0) return;

    const R = this.toolRadius;
    const rFloor = R - depth;
    if (rFloor <= 0) return;

    const D = rFloor + Rw;

    // Maximum angular extent: |sin(δ)| ≤ Rw / D
    const sinLimit = Math.min(1, Rw / D);
    const deltaMaxRad = Math.asin(sinLimit);

    const thetaCenterRad =
      ((thetaCenterDeg * DEG2RAD) % TWO_PI + TWO_PI) % TWO_PI;

    const cellsToCheck = Math.ceil(deltaMaxRad / this.dtheta) + 2;
    const centerCell =
      Math.round(thetaCenterRad / this.dtheta) % this.ntheta;

    const row = this.heightmap[iz];
    for (let d = -cellsToCheck; d <= cellsToCheck; d++) {
      const itheta =
        ((centerCell + d) % this.ntheta + this.ntheta) % this.ntheta;
      const thetaCell = itheta * this.dtheta;

      const delta = wrapAngle(thetaCell - thetaCenterRad);
      const absDelta = Math.abs(delta);

      const sinD = Math.sin(absDelta);
      const disc = Rw * Rw - D * D * sinD * sinD;
      if (disc < 0) continue;

      const cosD = Math.cos(absDelta);
      const rNew = D * cosD - Math.sqrt(disc);
      if (rNew <= 0 || rNew >= R) continue;

      if (rNew < row[itheta]) {
        row[itheta] = rNew;
      }
    }
  }

  /**
   * Apply a flat-plane cross-section cut at heightmap row `iz`,
   * centred at angular position `thetaCenterDeg` with the given depth.
   *
   * Model: a flat plane perpendicular to the radial direction at the
   * contact angle, offset inward by `depth` from the tool OD.
   * At angular offset δ from centre the new radius is:
   *   r(δ) = (R − depth) / cos(δ)      for |δ| < arccos((R−depth)/R)
   *
   * Used for OD-relief facets (side-of-wheel grinding).
   */
  _cutFlatFacet(iz, thetaCenterDeg, depth) {
    if (iz < 0 || iz >= this.nz || depth <= 0) return;

    const R = this.toolRadius;
    const rFlat = R - depth;
    if (rFlat <= 0) return;

    const deltaMaxRad = Math.acos(Math.max(0, Math.min(1, rFlat / R)));
    const thetaCenterRad =
      ((thetaCenterDeg * DEG2RAD) % TWO_PI + TWO_PI) % TWO_PI;

    const cellsToCheck = Math.ceil(deltaMaxRad / this.dtheta) + 2;
    const centerCell =
      Math.round(thetaCenterRad / this.dtheta) % this.ntheta;

    const row = this.heightmap[iz];
    for (let d = -cellsToCheck; d <= cellsToCheck; d++) {
      const itheta =
        ((centerCell + d) % this.ntheta + this.ntheta) % this.ntheta;
      const thetaCell = itheta * this.dtheta;

      const delta = wrapAngle(thetaCell - thetaCenterRad);
      const absDelta = Math.abs(delta);
      if (absDelta >= deltaMaxRad) continue;

      const cosD = Math.cos(absDelta);
      if (cosD <= 1e-9) continue;

      const rNew = rFlat / cosD;
      if (rNew < row[itheta]) {
        row[itheta] = rNew;
      }
    }
  }

  /* ---- Section helpers ---- */

  /** Compute per-section Y min/max from classified frames. */
  _sectionYRanges(classifiedFrames) {
    const map = {};
    for (const f of classifiedFrames) {
      if (!f.section) continue;
      if (!map[f.section]) map[f.section] = { yMin: f.y, yMax: f.y };
      else {
        if (f.y < map[f.section].yMin) map[f.section].yMin = f.y;
        if (f.y > map[f.section].yMax) map[f.section].yMax = f.y;
      }
    }
    return map;
  }

  /**
   * Map a frame's Y value to a heightmap z-index.
   * Y_max (first frame) → tip of tool → z = blankLength
   * Y_min (last frame)  → shank side  → z = blankLength − opLength
   */
  _frameToZIndex(frame, yRange, opLength) {
    if (!yRange || yRange.yMax === yRange.yMin) return -1;
    const tNorm =
      (yRange.yMax - frame.y) / (yRange.yMax - yRange.yMin);
    const zWp = this.blankLength - tNorm * opLength;
    return Math.round(zWp / this.dz);
  }

  /** Estimate radial infeed depth from NC tool center (X/Z). */
  _depthFromFrame(frame, op) {
    const radial = Math.hypot(frame.x, frame.z);
    if (!Number.isFinite(radial)) return null;

    if (op === "flute") {
      // Wheel center distance D = rFloor + Rw, so depth = R - (D - Rw).
      const rFloor = radial - this.fluteWheelRadius;
      return this.toolRadius - rFloor;
    }

    // Flat facet: depth equals how far the wheel center is inside the tool OD.
    return this.toolRadius - radial;
  }

  _wheelParamsForOp(op) {
    if (!op) return null;
    if (op.type === "flute") {
      const grindSide = this.wheel2GrindSide || "+y";
      const grindAtPlusY = grindSide === "+y";
      const bodyDir = grindAtPlusY ? -1 : 1;
      const centerOffset = -this.wheel2YOffsetMm + bodyDir * (this.wheel2WidthMm / 2);
      const offsetDeg = op.index === 2
        ? this.flute2WheelOffsetAngleDeg
        : this.flute1WheelOffsetAngleDeg;
      return {
        radius: this.wheel2RadiusMm,
        halfWidth: this.wheel2WidthMm / 2,
        offsetDeg,
        centerOffset,
      };
    }
    const grindSide = this.wheel1GrindSide || "-y";
    const grindAtMinusY = grindSide === "-y";
    const bodyDir = grindAtMinusY ? 1 : -1;
    const centerOffset = -this.wheel1YOffsetMm + bodyDir * (this.wheel1WidthMm / 2);
    return {
      radius: this.wheel1RadiusMm,
      halfWidth: this.wheel1WidthMm / 2,
      offsetDeg: 0,
      centerOffset,
    };
  }

  _wheelCenterMachine(frame, centerOffset = 0) {
    const xValue = frame.x * this.axisSigns.x + this.axisOffsets.x;
    const yValue = frame.y * this.axisSigns.y + this.axisOffsets.y;
    const zValue = frame.z * this.axisSigns.z + this.axisOffsets.z;

    const center = this.spindleOriginMachine.clone().add(
      this.spindleAxisDir.clone().multiplyScalar(centerOffset)
    );

    // Legacy mode kept wheelhead fixed in X to simplify early previewing.
    // For real NC alignment (including blank-length shifts), include X travel.
    if (!this.useWheelheadYZOnly) {
      center.add(this.axisDirections.x.clone().multiplyScalar(xValue));
    }

    center
      .add(this.axisDirections.y.clone().multiplyScalar(yValue))
      .add(this.axisDirections.z.clone().multiplyScalar(zValue));

    return center;
  }

  _wheelAxisMachine(offsetDeg) {
    const axis = this.spindleAxisDir.clone().normalize();
    const aDir = this.axisDirections.a.clone().normalize();
    if (Number.isFinite(offsetDeg) && Math.abs(offsetDeg) > 1e-6) {
      axis.applyAxisAngle(aDir, offsetDeg * DEG2RAD);
    }
    return axis.normalize();
  }

  _applyRotaryAxes(frame, centerMachine, axisMachine, applyC = true) {
    const aValue = frame.a * this.axisSigns.a + this.axisOffsets.a;
    const cValue = frame.c * this.axisSigns.c + this.axisOffsets.c;
    const aAxis = this.axisDirections.a.clone().normalize();
    const cAxis = this.axisDirections.c.clone().normalize();

    if (applyC && Math.abs(cValue) > 1e-9) {
      const qC = new THREE.Quaternion().setFromAxisAngle(cAxis, -cValue * DEG2RAD);
      if (centerMachine) {
        centerMachine.sub(this.cAxisPivot).applyQuaternion(qC).add(this.cAxisPivot);
      }
      if (axisMachine) axisMachine.applyQuaternion(qC);
    }

    if (Math.abs(aValue) > 1e-9) {
      const qA = new THREE.Quaternion().setFromAxisAngle(aAxis, aValue * DEG2RAD);
      if (centerMachine) {
        centerMachine.sub(this.aAxisPivot).applyQuaternion(qA).add(this.aAxisPivot);
      }
      if (axisMachine) axisMachine.applyQuaternion(qA);
    }
  }

  _distanceToBlankAxis(point) {
    const cross = point.clone().cross(new THREE.Vector3(1, 0, 0));
    return cross.length();
  }

  _closestAxisParams(centerSim, axisSim) {
    const u = new THREE.Vector3(1, 0, 0);
    const v = axisSim.clone().normalize();
    const p2 = centerSim.clone();
    const w0 = p2.clone().multiplyScalar(-1);

    const a = 1; // u·u
    const b = u.dot(v);
    const c = 1; // v·v
    const d = u.dot(w0);
    const e = v.dot(w0);
    const denom = a * c - b * b;

    if (Math.abs(denom) < 1e-9) {
      return {
        axisDist: Math.sqrt(p2.y * p2.y + p2.z * p2.z),
        tAxis: 0,
        axialInRange: true,
      };
    }

    const s = (b * e - c * d) / denom;
    const t = (a * e - b * d) / denom;
    const closest = w0.clone()
      .add(u.clone().multiplyScalar(s))
      .sub(v.clone().multiplyScalar(t));

    return {
      axisDist: closest.length(),
      tAxis: t,
      axialInRange: true,
    };
  }

  _updateDebug(frame, op, wheel, wheelCenterSim, wheelAxisSim, rawT = null, centerAdjust = 0, centerMachine = null, axisMachine = null) {
    const params = this._closestAxisParams(wheelCenterSim, wheelAxisSim);
    const axisDist = params.axisDist;
    const t = params.tAxis;
    const axialInRange = wheel.halfWidth > 0 ? Math.abs(t) <= wheel.halfWidth : true;
    const intersects = axisDist <= (wheel.radius + this.blankRadius);

    this.lastDebug = {
      line: frame.line,
      section: frame.section || "",
      op: op.type,
      wheelRadius: wheel.radius,
      wheelHalfWidth: wheel.halfWidth,
      wheelCenterOffset: wheel.centerOffset || 0,
      axisDist,
      axialInRange,
      intersects,
      centerSim: wheelCenterSim.clone(),
      axisSim: wheelAxisSim.clone(),
      centerMachine: centerMachine ? centerMachine.clone() : null,
      axisMachine: axisMachine ? axisMachine.clone() : null,
      aDeg: frame.a,
      cDeg: frame.c,
      tAxis: t,
      tAxisRaw: rawT,
      centerAdjust,
    };
  }

  getLastDebug() {
    return this.lastDebug;
  }

  _wheel2ShellProfile() {
    const odMm = Number.isFinite(this.wheel2ODMm) ? this.wheel2ODMm : null;
    const widthMm = Number.isFinite(this.wheel2WidthMm) ? this.wheel2WidthMm : null;
    const cornerMm = Number.isFinite(this.wheel2CornerRadiusMm)
      ? this.wheel2CornerRadiusMm
      : 0;
    const thicknessMm = Number.isFinite(this.wheel2ShellThicknessMm)
      ? this.wheel2ShellThicknessMm
      : null;
    const grindSide = String(this.wheel2GrindSide || "+y").trim().toLowerCase();

    if (!(odMm > 0) || !(widthMm > 0) || !(thicknessMm > 0)) {
      console.log("Wheel2 shell profile: INVALID", { odMm, widthMm, thicknessMm });
      return null;
    }

    const profile = {
      radius: odMm / 2,
      halfWidth: widthMm / 2,
      cornerRadius: Math.max(0, cornerMm),
      thickness: thicknessMm,
      grindSide,
    };
    console.log("Wheel2 shell profile created:", profile);
    return profile;
  }

  /**
   * Test if a point (in wheel-local coordinates) is inside the Wheel 2 voxel shell.
   * Uses the SAME logic as the voxel wheel mesh generation.
   * 
   * @param {number} r - radial distance from wheel axis (sqrt(x^2 + z^2))
   * @param {number} y - axial coordinate along wheel axis
   * @param {number} R - wheel OD radius (wheel2ODMm / 2)
   * @param {number} h - wheel half-width (wheel2WidthMm / 2)
   * @param {number} rc - corner radius (wheel2CornerRadiusMm)
   * @param {number} t - shell thickness (wheel2ShellThicknessMm)
   * @returns {boolean} true if point is inside the shell
   */
  _pointInWheel2Shell(r, y, R, h, rc, t) {
    // (A) Rectangular radial shell: (R - t <= r <= R) AND (-h <= y <= h)
    const inRect = (r >= R - t && r <= R) && (y >= -h && y <= h);
    if (inRect) return true;

    if (!(rc > 0)) return false;

    // (B) Top fillet (outer +y corner): (r - (R - rc))^2 + (y - (h - rc))^2 <= rc^2
    const dr_top = r - (R - rc);
    const dy_top = y - (h - rc);
    const inTopFillet = (dr_top * dr_top + dy_top * dy_top <= rc * rc);
    if (inTopFillet) return true;

    // (C) Bottom fillet (outer -y corner): (r - (R - rc))^2 + (y + (h - rc))^2 <= rc^2
    const dr_bottom = r - (R - rc);
    const dy_bottom = y + (h - rc);
    const inBottomFillet = (dr_bottom * dr_bottom + dy_bottom * dy_bottom <= rc * rc);
    
    return inBottomFillet;
  }

  /**
   * Apply Wheel 2 (1A1) flat-face grinding removal.
   * 1A1 wheels grind with a FLAT FACE, not the cylindrical OD.
   */
  _applyWheel2ShellSweep(centerSim, axisSim, shell, stats, minRadius = null) {
    if (!shell) return;
    const R = shell.radius;
    const h = shell.halfWidth;
    const grindSide = shell.grindSide || "+y";
    if (!(R > 0) || !(h > 0)) return;

    // Grinding face position: +h for +y side, -h for -y side
    const faceOffset = grindSide === "+y" ? h : -h;

    const axisDir = axisSim.clone().normalize();
    const rayOrigin = new THREE.Vector3();
    const rayDir = new THREE.Vector3();

    for (let iz = 0; iz < this.nz; iz++) {
      const x = iz * this.dz;
      const row = this.heightmap[iz];
      rayOrigin.set(x, 0, 0);

      for (let it = 0; it < this.ntheta; it++) {
        const rCurrent = row[it];
        if (rCurrent <= 0) continue;

        const theta = it * this.dtheta;
        rayDir.set(0, Math.cos(theta), Math.sin(theta));

        // Find intersection with the flat grinding face (a plane perpendicular to wheel axis)
        const v = rayOrigin.clone().sub(centerSim);
        const rayDotAxis = rayDir.dot(axisDir);
        
        // Skip if ray is parallel to grinding face
        if (Math.abs(rayDotAxis) < 1e-9) continue;

        // Distance along ray to the grinding plane
        const originDotAxis = v.dot(axisDir);
        const tPlane = (faceOffset - originDotAxis) / rayDotAxis;
        
        // Intersection must be in front of ray origin and closer than current surface
        if (tPlane < 0 || tPlane >= rCurrent) continue;

        // Point where ray hits the grinding plane
        const hitPoint = v.clone().add(rayDir.clone().multiplyScalar(tPlane));
        
        // Check if hit point is within wheel's OD (radial distance from axis)
        const axialDist = hitPoint.dot(axisDir);
        const radialVec = hitPoint.clone().sub(axisDir.clone().multiplyScalar(axialDist));
        const radialDist = radialVec.length();
        
        // Material is removed if within the wheel's OD
        if (radialDist <= R) {
          const rHit = tPlane;
          const rClamped = Number.isFinite(minRadius) ? Math.max(rHit, minRadius) : rHit;
          if (rClamped < rCurrent) {
            row[it] = rClamped;
            if (stats) {
              stats.changedCells += 1;
              if (rClamped < stats.minRadius) stats.minRadius = rClamped;
            }
          }
        }
      }
    }
  }

  _applyWheelSweep(centerSim, axisSim, radius, halfWidth, stats, cornerRadius = 0, minRadius = null, shellProfile = null) {
    if (shellProfile) {
      console.log("Using Wheel2 shell removal logic - R =", shellProfile.radius);
      this._applyWheel2ShellSweep(centerSim, axisSim, shellProfile, stats, minRadius);
      return;
    }
    console.log("Using OLD cylinder removal logic - radius =", radius);
    if (!(radius > 0)) return;

    const axisDir = axisSim.clone().normalize();
    const rayOrigin = new THREE.Vector3();
    const rayDir = new THREE.Vector3();

    for (let iz = 0; iz < this.nz; iz++) {
      const x = iz * this.dz;
      const row = this.heightmap[iz];
      rayOrigin.set(x, 0, 0);

      for (let it = 0; it < this.ntheta; it++) {
        const rCurrent = row[it];
        if (rCurrent <= 0) continue;

        const theta = it * this.dtheta;
        rayDir.set(0, Math.cos(theta), Math.sin(theta));

        const rHit = cornerRadius > 0
          ? rayWheelProfileFirstHit(
            rayOrigin,
            rayDir,
            centerSim,
            axisDir,
            radius,
            halfWidth,
            cornerRadius
          )
          : rayCylinderFirstHit(
            rayOrigin,
            rayDir,
            centerSim,
            axisDir,
            radius,
            halfWidth
          );

        if (Number.isFinite(rHit) && rHit < rCurrent) {
          const rClamped = Number.isFinite(minRadius) ? Math.max(rHit, minRadius) : rHit;
          if (rClamped >= rCurrent) continue;
          row[it] = rClamped;
          if (stats) {
            stats.changedCells += 1;
            if (rClamped < stats.minRadius) stats.minRadius = rClamped;
          }
        }
      }
    }
  }

  getLastStats() {
    return this.lastStats;
  }

  getSweepSamples() {
    return this.sweepSamples;
  }

  /* ---- Main simulation ---- */

  /**
   * Replay all classified frames up to (and including) `frameIndex`
   * and update the heightmap accordingly.
   * @param {object[]} classifiedFrames  Output of classifyFrames()
   * @param {number}   frameIndex        Last frame to include
   */
  processUpToFrame(classifiedFrames, frameIndex) {
    this.reset();

    const yRanges = this._sectionYRanges(classifiedFrames);
    const end = Math.min(frameIndex, classifiedFrames.length - 1);

    const stats = { changedCells: 0, minRadius: this.blankRadius };
    this.sweepSamples = [];

    for (let i = 0; i <= end; i++) {
      const f = classifiedFrames[i];
      const op = opInfo(f.section);
      if (!op) continue;

      const yRange = yRanges[f.section];
      const opLen =
        op.type === "flute" ? this.fluteLength : this.odReliefLength;
      const iz = this._frameToZIndex(f, yRange, opLen);
      if (iz < 0) continue;

      const wheel = this._wheelParamsForOp(op);
      if (!wheel || !(wheel.radius > 0)) continue;

      const wheelAxisMachine = this._wheelAxisMachine(wheel.offsetDeg);
      const wheelCenterMachine = this._wheelCenterMachine(f, wheel.centerOffset || 0);
      const wheelCenterMachineRaw = wheelCenterMachine.clone();
      const wheelAxisMachineRaw = wheelAxisMachine.clone();

      const wheelCenterSim = wheelCenterMachine
        .clone()
        .sub(this.simToMachinePos)
        .applyQuaternion(this.machineToSimQuat);
      if (this.useNcFrame) {
        wheelCenterSim.set(
          wheelCenterMachine.x,
          wheelCenterMachine.y,
          wheelCenterMachine.z
        );
      }
      wheelCenterSim.add(this.sweepCenterOffset);
      const wheelAxisSimRaw = wheelAxisMachine
        .clone()
        .applyQuaternion(this.machineToSimQuat)
        .normalize();
      let wheelAxisSim = wheelAxisSimRaw.clone();
      // Keep wheel axis perpendicular to blank axis (X) for the voxel sweep.
      wheelAxisSim.x = 0;
      if (wheelAxisSim.lengthSq() < 1e-9) {
        wheelAxisSim.set(0, 1, 0);
      } else {
        wheelAxisSim.normalize();
      }
      if (this.lockSweepAxis) {
        wheelAxisSim = new THREE.Vector3(0, 1, 0);
      }
      // Map axial position from Y-range to sim X to stay on the blank axis.
      wheelCenterSim.x = iz * this.dz;
      let centerAdjust = 0;
      let tAxisRaw = null;
      if (wheel.halfWidth > 0) {
        const params = this._closestAxisParams(wheelCenterSim, wheelAxisSim);
        tAxisRaw = params.tAxis;
        if (Math.abs(params.tAxis) > wheel.halfWidth) {
          centerAdjust = params.tAxis;
          wheelCenterSim.add(
            wheelAxisSim.clone().multiplyScalar(centerAdjust)
          );
        }
      }

      this._updateDebug(
        f,
        op,
        wheel,
        wheelCenterSim,
        wheelAxisSim,
        tAxisRaw,
        centerAdjust,
        wheelCenterMachineRaw,
        wheelAxisMachineRaw
      );

      if (this.captureSweepEvery > 0 && i % this.captureSweepEvery === 0) {
        this.sweepSamples.push({
          center: wheelCenterSim.clone(),
          axis: wheelAxisSim.clone(),
          axisRaw: wheelAxisSimRaw.clone(),
          centerMachine: wheelCenterMachineRaw.clone(),
          axisMachine: wheelAxisMachineRaw.clone(),
          radius: wheel.radius,
          halfWidth: wheel.halfWidth,
        });
        if (this.sweepSamples.length > this.maxSweepSamples) {
          this.sweepSamples.shift();
        }
      }

      if (this.enableVoxelCut) {
        const shellProfile = op.type === "flute" ? this._wheel2ShellProfile() : null;
        this._applyWheelSweep(
          wheelCenterSim,
          wheelAxisSim,
          wheel.radius,
          wheel.halfWidth,
          stats,
          wheel.cornerRadius || 0,
          null,
          shellProfile
        );
      }
    }

    this.lastStats = stats;
  }

  /**
   * Apply a list of precomputed sweep samples in sim coordinates.
   * @param {{center: THREE.Vector3, axis: THREE.Vector3, radius: number, halfWidth: number}[]} samples
   */
  processSweepSamples(samples) {
    this.reset();
    const stats = { changedCells: 0, minRadius: this.blankRadius };
    console.log("processSweepSamples: processing", samples?.length, "samples");
    for (const s of samples || []) {
      if (!s || !s.center || !s.axis) continue;
      const shellProfile = Number.isFinite(s.minRadius) ? this._wheel2ShellProfile() : null;
      console.log("Sample: radius =", s.radius, "minRadius =", s.minRadius, "-> shellProfile =", shellProfile ? "VALID (R=" + shellProfile.radius + ")" : "NULL");
      this._applyWheelSweep(
        s.center,
        s.axis,
        s.radius,
        s.halfWidth,
        stats,
        s.cornerRadius || 0,
        s.minRadius ?? null,
        shellProfile
      );
    }
    this.lastStats = stats;
  }

  /* ---- Mesh generation ---- */

  /**
   * Build a Three.js BufferGeometry from the current heightmap.
   * Workpiece axis along +X.  Cross-section in Y/Z.
   */
  buildGeometry() {
    const { nz, ntheta, dz, dtheta, blankRadius } = this;
    const vertCount = nz * ntheta + 2; // +2 for cap centres
    const positions = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);
    const indices = [];

    const eps = 0.005; // mm tolerance for "uncut" detection
    const cBlank = new THREE.Color(0xffd18a); // original surface
    const cGround = new THREE.Color(0xb0b8c8); // ground surface

    // --- Ring vertices ---
    for (let iz = 0; iz < nz; iz++) {
      const x = iz * dz;
      for (let it = 0; it < ntheta; it++) {
        const r = this.heightmap[iz][it];
        const theta = it * dtheta;
        const vi = iz * ntheta + it;
        positions[vi * 3] = x;
        positions[vi * 3 + 1] = r * Math.cos(theta);
        positions[vi * 3 + 2] = r * Math.sin(theta);

        const col = r >= blankRadius - eps ? cBlank : cGround;
        colors[vi * 3] = col.r;
        colors[vi * 3 + 1] = col.g;
        colors[vi * 3 + 2] = col.b;
      }
    }

    // --- Side quads ---
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let it = 0; it < ntheta; it++) {
        const itNext = (it + 1) % ntheta;
        const a = iz * ntheta + it;
        const b = iz * ntheta + itNext;
        const c = (iz + 1) * ntheta + itNext;
        const d = (iz + 1) * ntheta + it;
        indices.push(a, b, c, a, c, d);
      }
    }

    // --- Chuck-end cap (iz = 0) ---
    const chuckIdx = nz * ntheta;
    positions[chuckIdx * 3] = 0;
    positions[chuckIdx * 3 + 1] = 0;
    positions[chuckIdx * 3 + 2] = 0;
    colors[chuckIdx * 3] = cBlank.r;
    colors[chuckIdx * 3 + 1] = cBlank.g;
    colors[chuckIdx * 3 + 2] = cBlank.b;
    for (let it = 0; it < ntheta; it++) {
      const itNext = (it + 1) % ntheta;
      indices.push(chuckIdx, itNext, it);
    }

    // --- Tip-end cap (iz = nz-1) ---
    const tipIdx = nz * ntheta + 1;
    positions[tipIdx * 3] = (nz - 1) * dz;
    positions[tipIdx * 3 + 1] = 0;
    positions[tipIdx * 3 + 2] = 0;
    colors[tipIdx * 3] = cBlank.r;
    colors[tipIdx * 3 + 1] = cBlank.g;
    colors[tipIdx * 3 + 2] = cBlank.b;
    const lastRing = (nz - 1) * ntheta;
    for (let it = 0; it < ntheta; it++) {
      const itNext = (it + 1) % ntheta;
      indices.push(tipIdx, lastRing + it, lastRing + itNext);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3)
    );
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Create a new Mesh, or update an existing one in-place.
   * @param {THREE.Mesh|null} existingMesh
   * @returns {THREE.Mesh}
   */
  buildMesh(existingMesh = null) {
    const geo = this.buildGeometry();

    if (existingMesh) {
      existingMesh.geometry.dispose();
      existingMesh.geometry = geo;
      return existingMesh;
    }

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.5,
      roughness: 0.35,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geo, mat);
  }
}
