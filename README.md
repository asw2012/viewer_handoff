# NC Orientation Viewer — Handoff Package

## What this is

A 5-axis grinding machine kinematic viewer. Loads NC code (X Y Z A C), animates
the machine through each move, and shows a blank cylinder being ground.

The machine model is a Syntec 5 axis tool grinding centre.
Axes: X/Y/Z linear, A = workpiece spindle, C = workhead rotation.

## Run

Requires Node.js (any recent version). That is the only dependency — no build tools, no compiler.

```
node dev_server.js
```

Open: **http://localhost:8091/**

## Load an NC file

1. Use the **NC Output Files** dropdown — it lists everything in `nc_output/`
2. Or use **Load NC file** to browse to any `.nc` file

## What you do NOT need

The NC file in `nc_output/` is pre-generated — it is the
ground truth input for this task. You do not need to regenerate it. Do not produce new NC output, only fix the
simulation that reads and visualises the existing NC file.

## What needs fixing — stock removal

`workpiece_sim.js` is the module to fix.

**Current behavior**
- Axis playback is correct (machine motion looks right).
- Stock removal is wrong: little or no visible cut, blank can stay cylindrical.
- Failure looks like wheel/blank intersection is missing or in the wrong frame.

**Needed fix**
- Replace the current flat-plane subtraction with true wheel-solid intersection in the per-cell heightmap loop.
- Wire existing helpers `rayWheelProfileFirstHit()` and `radiusAtAxialT()` into that loop.
- Keep both wheel profiles from `cfg/wheel.cfg` supported:
  - **11V9 (OD relief):** `wheel1ODMm`, `wheel1TaperAngleDeg`, `wheel1ActiveFaceMm`, `wheel1CornerRadiusMm`
  - **1A1 (flute):** `wheel2ODMm`, `wheel2WidthMm`, `wheel2CornerRadiusMm`

**Open transform question**
- Rays are cast in blank-local space.
- At each NC frame, when moving wheel center/axis from world to blank-local, is inverse A-axis rotation enough, or must A-axis pivot origin also be subtracted first?
- Wheel spindle stack may also be slightly offset in world space, which could contribute to the miss.

## File layout

```
dev_server.js          Node.js server (port 8091, self-contained)
index.html             Viewer UI
viewer.js              Three.js scene, machine hierarchy, NC playback
workpiece_sim.js       Stock removal simulation — THIS IS THE FILE TO FIX
styles.css             UI styles
mesh_mounts.json       Spindle axis direction + A-axis orientation config
cfg/                   blank.cfg, wheel.cfg, calibration_inputs.cfg
data/                  machine_definition.json, *.wrl mesh files, kinematics
nc_output/             Sample NC file (2-flute 14mm endmill, 65mm flute length)
```

## Machine geometry reference

- Blank: 14mm diameter, 100mm length (from `cfg/blank.cfg`)
- Wheel: 125mm diameter, 1mm corner radius (from `cfg/wheel.cfg`)
- Calibration lengths in `cfg/calibration_inputs.cfg`
- Machine node hierarchy (pivot points, parent/child) in `data/machine_definition.json`
