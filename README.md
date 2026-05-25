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
ground truth input for this task. You do not need to regenerate it. Your job is to fix the
simulation that reads and visualises the existing NC file, not to produce new NC output.

## What needs fixing — stock removal

The file `workpiece_sim.js` is the stock removal simulation module.

It currently uses a flat-plane approximation to cut into the blank cylinder as the
machine moves. The result is not geometrically correct — the removed material does
not match the actual wheel geometry or the grinding contact.

**What is needed:**

The grinding wheel is a cup wheel (annular face). Its geometry is defined in
`cfg/wheel.cfg` (diameter, width, corner radius). At each NC frame the wheel
center position and axis orientation are fully known from the machine kinematics.

The fix is to replace the flat-plane subtraction in `workpiece_sim.js` with a
correct wheel solid intersection against the blank cylinder.

Two wheel profiles are needed (both defined in `cfg/wheel.cfg`):
- **Wheel 1 (11V9)** — flaring cup / cone frustum. OD relief grinding. Parameters:
  `wheel1ODMm`, `wheel1TaperAngleDeg`, `wheel1ActiveFaceMm`, `wheel1CornerRadiusMm`.
- **Wheel 2 (1A1)** — straight cylinder with corner radius. Flute grinding. Parameters:
  `wheel2ODMm`, `wheel2WidthMm`, `wheel2CornerRadiusMm`.

The helper functions `rayWheelProfileFirstHit()` and `radiusAtAxialT()` are already
stubbed in `workpiece_sim.js` for this purpose — they just need to be wired into the
per-cell heightmap subtraction loop.

**Coordinate frame note:** the rays must be cast in the blank's local coordinate
frame, not world space. At each NC frame, apply the inverse of the A-axis rotation
(workpiece spindle angle) to bring the wheel center and axis direction into blank
space before intersecting against the heightmap. The viewer's kinematic tree already
computes the world-space wheel pose per frame — it just needs to be inverse-transformed
by the cumulative A rotation to get into blank local space.

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
