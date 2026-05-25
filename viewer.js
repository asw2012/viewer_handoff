import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { VRMLLoader } from "three/addons/loaders/VRMLLoader.js";
import { WorkpieceSim, parseNcSections, classifyFrames } from "./workpiece_sim.js";

const VIEWER_BUILD = "2026-04-30T-feed-aware-playback";
console.warn(`[viewer] build=${VIEWER_BUILD} loaded`);

const VIEWER_BLANK_Y_NUDGE_MM = 0;
const VIEWER_Y_AXIS_OFFSET_MM = 75;
const VIEWER_SHOW_VOXELS = false;
const VIEWER_USE_NC_FRAME = false;
const VIEWER_SWEEP_IN_MACHINE = false;
let VIEWER_LOCK_SWEEP_AXIS = true;
const VIEWER_SWEEP_CENTER_OFFSET = new THREE.Vector3(0, 0, 0);

const state = {
  frames: [],
  segmentDurations: [],
  frameIndex: 0,
  playing: false,
  speed: 0.15,
  timeAccumulator: 0,
  currentNcPath: null,
  currentNcLabel: null,
};

const DEFAULT_PLAYBACK_FRAME_TIME_SEC = 1 / 30;
const REFERENCE_FEED_MM_MIN = 120;
const MIN_FEED_MM_MIN = 1;

const simState = {
  sim: null,
  mesh: null,
  classifiedFrames: [],
  ncText: null,
  sweepGroup: null,
};
let toolCfg = {};

const WATCH_INTERVAL_MS = 1500;
const LAST_NC_SELECTION_KEY = "ncOrientationViewer:lastNcSelection";
const WATCHED_CFG_PATHS = [
  "/cfg/blank.cfg",
  "/cfg/tool_2flute.cfg",
  "/cfg/wheel.cfg",
  "/cfg/calibration_inputs.cfg",
];

const watchState = {
  timerId: null,
  busy: false,
  cfgStamps: new Map(),
  ncStamp: null,
  ncFilesSignature: null,
};

const ui = {
  ncFile: document.getElementById("ncFile"),
  ncSelect: document.getElementById("ncSelect"),
  frameSlider: document.getElementById("frameSlider"),
  frameLabel: document.getElementById("frameLabel"),
  status: document.getElementById("status"),
  playBtn: document.getElementById("playBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  resetBtn: document.getElementById("resetBtn"),
  homeBtn: document.getElementById("homeBtn"),
  speed: document.getElementById("speed"),
  speedSlider: document.getElementById("speedSlider"),
  speedLabel: document.getElementById("speedLabel"),
  sweepToggle: document.getElementById("sweepToggle"),
  sweepAxisToggle: document.getElementById("sweepAxisToggle"),
  simBenchBtn: document.getElementById("simBenchBtn"),
  simBenchOut: document.getElementById("simBenchOut"),
  applyBtn: document.getElementById("applyBtn"),
  saveKinematicsBtn: document.getElementById("saveKinematicsBtn"),
  pathToggle: document.getElementById("pathToggle"),
  basisRx: document.getElementById("basisRx"),
  basisRy: document.getElementById("basisRy"),
  basisRz: document.getElementById("basisRz"),
  applyBasisBtn: document.getElementById("applyBasisBtn"),
  nodeSelect: document.getElementById("nodeSelect"),
  nodeRx: document.getElementById("nodeRx"),
  nodeRy: document.getElementById("nodeRy"),
  nodeRz: document.getElementById("nodeRz"),
  nodeRxSlider: document.getElementById("nodeRxSlider"),
  nodeRySlider: document.getElementById("nodeRySlider"),
  nodeRzSlider: document.getElementById("nodeRzSlider"),
  nodeTx: document.getElementById("nodeTx"),
  nodeTy: document.getElementById("nodeTy"),
  nodeTz: document.getElementById("nodeTz"),
  applyNodeRotBtn: document.getElementById("applyNodeRotBtn"),
  hudX: document.getElementById("hudX"),
  hudY: document.getElementById("hudY"),
  hudZ: document.getElementById("hudZ"),
  hudA: document.getElementById("hudA"),
  hudC: document.getElementById("hudC"),
  hudF: document.getElementById("hudF"),
};

const signInputs = {
  x: document.getElementById("sx"),
  y: document.getElementById("sy"),
  z: document.getElementById("sz"),
  a: document.getElementById("sa"),
  c: document.getElementById("sc"),
};

const offsetInputs = {
  x: document.getElementById("ox"),
  y: document.getElementById("oy"),
  z: document.getElementById("oz"),
  a: document.getElementById("oa"),
  c: document.getElementById("oc"),
};

const axisDirectionInputs = {
  x: {
    dx: document.getElementById("xAxisDx"),
    dy: document.getElementById("xAxisDy"),
    dz: document.getElementById("xAxisDz"),
  },
  y: {
    dx: document.getElementById("yAxisDx"),
    dy: document.getElementById("yAxisDy"),
    dz: document.getElementById("yAxisDz"),
  },
  z: {
    dx: document.getElementById("zAxisDx"),
    dy: document.getElementById("zAxisDy"),
    dz: document.getElementById("zAxisDz"),
  },
  a: {
    dx: document.getElementById("aAxisDx"),
    dy: document.getElementById("aAxisDy"),
    dz: document.getElementById("aAxisDz"),
  },
  c: {
    dx: document.getElementById("cAxisDx"),
    dy: document.getElementById("cAxisDy"),
    dz: document.getElementById("cAxisDz"),
  },
};

function numberInputValue(element, fallback = 0) {
  const value = Number.parseFloat(element.value);
  return Number.isFinite(value) ? value : fallback;
}

function normalizedAxisVector(inputTriplet, fallbackVector) {
  const vector = new THREE.Vector3(
    numberInputValue(inputTriplet?.dx, fallbackVector.x),
    numberInputValue(inputTriplet?.dy, fallbackVector.y),
    numberInputValue(inputTriplet?.dz, fallbackVector.z)
  );
  if (vector.lengthSq() < 1e-12) {
    return fallbackVector.clone();
  }
  return vector.normalize();
}

function collectTransformSettings() {
  const signs = {
    x: Math.sign(numberInputValue(signInputs.x, 1)) || 1,
    y: Math.sign(numberInputValue(signInputs.y, 1)) || 1,
    z: Math.sign(numberInputValue(signInputs.z, 1)) || 1,
    a: Math.sign(numberInputValue(signInputs.a, 1)) || 1,
    c: Math.sign(numberInputValue(signInputs.c, 1)) || 1,
  };

  const offsets = {
    x: numberInputValue(offsetInputs.x, 0),
    y: numberInputValue(offsetInputs.y, 0),
    z: numberInputValue(offsetInputs.z, 0),
    a: numberInputValue(offsetInputs.a, 0),
    c: numberInputValue(offsetInputs.c, 0),
  };

  const axisDirections = {
    x: normalizedAxisVector(axisDirectionInputs.x, new THREE.Vector3(1, 0, 0)),
    y: normalizedAxisVector(axisDirectionInputs.y, new THREE.Vector3(0, 1, 0)),
    z: normalizedAxisVector(axisDirectionInputs.z, new THREE.Vector3(0, 0, 1)),
    a: normalizedAxisVector(axisDirectionInputs.a, new THREE.Vector3(1, 0, 0)),
    c: normalizedAxisVector(axisDirectionInputs.c, new THREE.Vector3(0, 0, -1)),
  };

  return { signs, offsets, axisDirections };
}

function roundVectorComponent(value) {
  return Number(value.toFixed(6));
}

function updateAxisHud(values) {
  if (!values) return;
  if (ui.hudX) ui.hudX.textContent = Number(values.x || 0).toFixed(3);
  if (ui.hudY) ui.hudY.textContent = Number(values.y || 0).toFixed(3);
  if (ui.hudZ) ui.hudZ.textContent = Number(values.z || 0).toFixed(3);
  if (ui.hudA) ui.hudA.textContent = Number(values.a || 0).toFixed(3);
  if (ui.hudC) ui.hudC.textContent = Number(values.c || 0).toFixed(3);
  if (ui.hudF) {
    const feedValue = Number(values.feed);
    if (Number.isFinite(feedValue) && feedValue > 0) {
      ui.hudF.textContent = feedValue.toFixed(3);
    } else {
      ui.hudF.textContent = values.motionMode === "G00" ? "RAPID" : "-";
    }
  }
}

function axisDirectionsPayload(settings) {
  return {
    x_axis: settings.axisDirections.x.toArray().map(roundVectorComponent),
    y_axis: settings.axisDirections.y.toArray().map(roundVectorComponent),
    z_axis: settings.axisDirections.z.toArray().map(roundVectorComponent),
    c_axis: settings.axisDirections.c.toArray().map(roundVectorComponent),
    a_axis: settings.axisDirections.a.toArray().map(roundVectorComponent),
  };
}

async function saveKinematicsInputs() {
  const settings = collectTransformSettings();
  const axisDirections = axisDirectionsPayload(settings);

  let existing = {};
  try {
    const existingResponse = await fetch("/data/kinematics_inputs.json", { cache: "no-store" });
    if (existingResponse.ok) {
      existing = await existingResponse.json();
    }
  } catch {
    existing = {};
  }

  const payload = {
    ...existing,
    axis_directions: {
      ...(existing.axis_directions || {}),
      ...axisDirections,
    },
    axis_signs: {
      ...(existing.axis_signs || {}),
      x: settings.signs.x,
      y: settings.signs.y,
      z: settings.signs.z,
      a: settings.signs.a,
      c: settings.signs.c,
    },
    axis_offsets: {
      ...(existing.axis_offsets || {}),
      x: roundVectorComponent(settings.offsets.x),
      y: roundVectorComponent(settings.offsets.y),
      z: roundVectorComponent(settings.offsets.z),
      a: roundVectorComponent(settings.offsets.a),
      c: roundVectorComponent(settings.offsets.c),
    },
    mesh_rotations_deg_xyz: {
      ...(existing.mesh_rotations_deg_xyz || {}),
      ...Object.fromEntries(
        Array.from(nodeMeshRotOverrides.entries()).map(([name, rot]) => [
          name,
          [
            roundVectorComponent(rot.rx),
            roundVectorComponent(rot.ry),
            roundVectorComponent(rot.rz),
          ],
        ])
      ),
    },
    mesh_translations_mm: {
      ...(existing.mesh_translations_mm || {}),
      ...Object.fromEntries(
        Array.from(nodeMeshPosOverrides.entries()).map(([name, pos]) => [
          name,
          [
            roundVectorComponent(pos.tx),
            roundVectorComponent(pos.ty),
            roundVectorComponent(pos.tz),
          ],
        ])
      ),
    },
  };

  const response = await fetch("/api/save-kinematics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload, null, 2),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  ui.status.textContent = [
    "Saved kinematics inputs to data/kinematics_inputs.json",
    `x_axis: [${payload.axis_directions.x_axis.join(", ")}]`,
    `y_axis: [${payload.axis_directions.y_axis.join(", ")}]`,
    `z_axis: [${payload.axis_directions.z_axis.join(", ")}]`,
    `c_axis: [${payload.axis_directions.c_axis.join(", ")}]`,
    `a_axis: [${payload.axis_directions.a_axis.join(", ")}]`,
  ].join("\n");
}

function parseNc(text) {
  const lines = text.split(/\r?\n/);
  const frames = [];

  let absolute = true;
  let motionMode = "G00";
  let modalFeedMmMin = null;
  const current = { x: 0, y: 0, z: 0, a: 0, c: 0 };

  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index];
    const clean = original.replace(/\([^)]*\)/g, " ").replace(/;.*$/g, " ").trim().toUpperCase();
    if (!clean) continue;

    if (clean.includes("G90")) absolute = true;
    if (clean.includes("G91")) absolute = false;
    if (/\bG0*0\b/.test(clean)) motionMode = "G00";
    if (/\bG0*1\b/.test(clean)) motionMode = "G01";

    const words = {};
    const regex = /([A-Z])\s*([-+]?\d*\.?\d+)/g;
    let match = null;
    while ((match = regex.exec(clean)) !== null) {
      words[match[1]] = Number.parseFloat(match[2]);
    }

    if ("F" in words && Number.isFinite(words.F) && words.F > 0) {
      modalFeedMmMin = words.F;
    }

    const hasAnyAxis = ["X", "Y", "Z", "A", "C"].some((k) => k in words);
    if (!hasAnyAxis) continue;

    for (const [key, axis] of [["X", "x"], ["Y", "y"], ["Z", "z"], ["A", "a"], ["C", "c"]]) {
      if (!(key in words)) continue;
      const value = words[key];
      if (absolute) current[axis] = value;
      else current[axis] += value;
    }

    frames.push({
      line: index + 1,
      raw: original,
      x: current.x,
      y: current.y,
      z: current.z,
      a: current.a,
      c: current.c,
      feed: motionMode === "G01" ? modalFeedMmMin : null,
      motionMode,
    });
  }

  return frames;
}

function buildPlaybackSegmentDurations(frames) {
  // Keep legacy pacing near F120 while making higher/lower F values visibly faster/slower.
  const durations = new Array(frames.length).fill(DEFAULT_PLAYBACK_FRAME_TIME_SEC);
  if (!frames.length) return durations;

  durations[0] = 0;
  let fallbackFeed = REFERENCE_FEED_MM_MIN;

  for (let i = 1; i < frames.length; i += 1) {
    const rawFeed = frames[i].feed ?? frames[i - 1].feed;
    const feedMmMin = Number.isFinite(rawFeed) && rawFeed > 0 ? rawFeed : fallbackFeed;
    fallbackFeed = feedMmMin;
    durations[i] = DEFAULT_PLAYBACK_FRAME_TIME_SEC * (REFERENCE_FEED_MM_MIN / Math.max(MIN_FEED_MM_MIN, feedMmMin));
  }

  return durations;
}

function stampSignature(stamp) {
  if (!stamp) return "missing";
  const size = Number(stamp.size || 0);
  const mtimeMs = Number(stamp.mtimeMs || 0);
  return `${size}:${mtimeMs}`;
}

async function fetchFileStamp(repoPath) {
  const response = await fetch(`/api/file-stamp?path=${encodeURIComponent(repoPath)}`, {
    cache: "no-store",
  });
  if (!response.ok) return null;
  return response.json();
}

async function loadNcFromPath(pathname, label) {
  try {
    const response = await fetch(pathname, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status}`);
    }
    const text = await response.text();
    state.currentNcPath = pathname;
    state.currentNcLabel = label || pathname;
    watchState.ncStamp = null;
    simState.ncText = text;
    const frames = parseNc(text);
    loadFrames(frames);

    // Re-read configs so depth / geometry changes take effect without
    // a full page reload.
    await loadBlankInputs();
    await loadToolInputs();
    await loadWheelInputs();

    initWorkpieceSim();

    if (label && ui.status) {
      ui.status.textContent = `Loaded ${label}.\n` + ui.status.textContent;
    }
  } catch (error) {
    if (ui.status) {
      ui.status.textContent = `Failed to load ${label || pathname}: ${error.message || error}`;
    }
  }
}

function rebuildBlankMeshFromCurrentCfg() {
  const aAxisDyn = nodeState.get("a_axis")?.dynamicGroup;
  if (!aAxisDyn) return;

  const blank = aAxisDyn.getObjectByName("workpiece_blank");
  if (blank) {
    aAxisDyn.remove(blank);
    if (blank.geometry) blank.geometry.dispose();
    if (blank.material && typeof blank.material.dispose === "function") {
      blank.material.dispose();
    }
  }

  buildBlankMesh(aAxisDyn);

  if (simState.mesh) {
    const updatedBlank = aAxisDyn.getObjectByName("workpiece_blank");
    if (updatedBlank) updatedBlank.visible = false;
  }
}

async function maybeRefreshConfigsFromDisk() {
  let changed = false;

  for (const repoPath of WATCHED_CFG_PATHS) {
    const stamp = await fetchFileStamp(repoPath);
    const nextSignature = stampSignature(stamp);
    if (!watchState.cfgStamps.has(repoPath)) {
      watchState.cfgStamps.set(repoPath, nextSignature);
      continue;
    }
    if (watchState.cfgStamps.get(repoPath) !== nextSignature) {
      watchState.cfgStamps.set(repoPath, nextSignature);
      changed = true;
    }
  }

  if (!changed) return;

  await loadCalibrationInputs();
  await loadBlankInputs();
  await loadToolInputs();
  await loadWheelInputs();

  rebuildBlankMeshFromCurrentCfg();

  if (simState.ncText && state.frames.length) {
    initWorkpieceSim();
  }

  if (state.frames.length && hierarchyReady) {
    applyFrame(Math.min(state.frameIndex, state.frames.length - 1));
  }

  if (ui.status) {
    ui.status.textContent = `Detected cfg update on disk. Viewer refreshed.\n${ui.status.textContent}`;
  }
}

async function maybeRefreshSelectedNcFromDisk() {
  if (!state.currentNcPath) return;

  const stamp = await fetchFileStamp(state.currentNcPath);
  const nextSignature = stampSignature(stamp);

  if (!watchState.ncStamp) {
    watchState.ncStamp = nextSignature;
    return;
  }

  if (watchState.ncStamp === nextSignature) return;

  watchState.ncStamp = nextSignature;
  await loadNcFromPath(state.currentNcPath, state.currentNcLabel || state.currentNcPath);

  if (ui.status) {
    ui.status.textContent = `Detected NC update on disk. Reloaded ${state.currentNcLabel || state.currentNcPath}.\n${ui.status.textContent}`;
  }
}

function startDiskWatchLoop() {
  if (watchState.timerId !== null) return;

  watchState.timerId = window.setInterval(async () => {
    if (watchState.busy) return;
    watchState.busy = true;
    try {
      await maybeRefreshConfigsFromDisk();
      await maybeRefreshNcFileListFromDisk();
      await maybeRefreshSelectedNcFromDisk();
    } catch (_) {
      // Keep the watcher alive; transient read errors should not stop refresh.
    } finally {
      watchState.busy = false;
    }
  }, WATCH_INTERVAL_MS);
}

function ncFileListSignature(files) {
  return files.join("\n");
}

async function fetchNcFileNames() {
  const response = await fetch("/api/nc-files", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.files) ? payload.files : [];
}

function rebuildNcSelectOptions(files, preferredSelection = "") {
  if (!ui.ncSelect) return;

  ui.ncSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(select from nc_output)";
  ui.ncSelect.appendChild(placeholder);

  for (const fileName of files) {
    const option = document.createElement("option");
    option.value = fileName;
    option.textContent = fileName;
    ui.ncSelect.appendChild(option);
  }

  let selected = "";
  if (preferredSelection && files.includes(preferredSelection)) {
    selected = preferredSelection;
  } else {
    const remembered = window.localStorage.getItem(LAST_NC_SELECTION_KEY);
    if (remembered && files.includes(remembered)) {
      selected = remembered;
    }
  }

  if (selected) {
    ui.ncSelect.value = selected;
  }
}

async function maybeRefreshNcFileListFromDisk() {
  if (!ui.ncSelect) return;

  const files = await fetchNcFileNames();
  const nextSignature = ncFileListSignature(files);

  if (watchState.ncFilesSignature === null) {
    watchState.ncFilesSignature = nextSignature;
    return;
  }

  if (watchState.ncFilesSignature === nextSignature) return;

  const currentSelection = ui.ncSelect.value;
  rebuildNcSelectOptions(files, currentSelection);
  watchState.ncFilesSignature = nextSignature;

  if (ui.status) {
    ui.status.textContent = `Detected nc_output list change. Dropdown updated.\n${ui.status.textContent}`;
  }

  // Auto-load the newest NC file when the list changes (e.g. after a new run).
  // Files are sorted alphabetically; since names are timestamped the last entry is newest.
  if (files.length > 0) {
    const newestFile = files[files.length - 1];
    const newestPath = `/nc_output/${newestFile}`;
    if (newestPath !== state.currentNcPath) {
      ui.ncSelect.value = newestFile;
      window.localStorage.setItem(LAST_NC_SELECTION_KEY, newestFile);
      await loadNcFromPath(newestPath, newestFile);
    }
  }
}

async function refreshNcFileList() {
  if (!ui.ncSelect) return;
  ui.ncSelect.disabled = true;
  try {
    const files = await fetchNcFileNames();
    const currentSelection = ui.ncSelect.value;
    rebuildNcSelectOptions(files, currentSelection);
    watchState.ncFilesSignature = ncFileListSignature(files);
  } catch (error) {
    if (ui.status) {
      ui.status.textContent = `Failed to list nc_output: ${error.message || error}`;
    }
  } finally {
    ui.ncSelect.disabled = false;
  }
}

function eulerQuaternionFromDegXYZ(rx, ry, rz) {
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rx),
    THREE.MathUtils.degToRad(ry),
    THREE.MathUtils.degToRad(rz),
    "XYZ"
  );
  const q = new THREE.Quaternion();
  q.setFromEuler(euler);
  return q;
}

const viewport = document.getElementById("viewport");
const splitter = document.getElementById("splitter");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
viewport.appendChild(renderer.domElement);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resizeViewport() {
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
}

if (splitter) {
  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);

    const onPointerMove = (moveEvent) => {
      const minWidth = 260;
      const maxWidth = Math.floor(window.innerWidth * 0.7);
      const nextWidth = clamp(moveEvent.clientX, minWidth, maxWidth);
      document.documentElement.style.setProperty("--ui-width", `${nextWidth}px`);
      resizeViewport();
    };

    const stopDragging = () => {
      splitter.removeEventListener("pointermove", onPointerMove);
      splitter.removeEventListener("pointerup", stopDragging);
      splitter.removeEventListener("pointercancel", stopDragging);
    };

    splitter.addEventListener("pointermove", onPointerMove);
    splitter.addEventListener("pointerup", stopDragging);
    splitter.addEventListener("pointercancel", stopDragging);
  });
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(55, viewport.clientWidth / viewport.clientHeight, 0.1, 5000);
camera.position.set(0, -320, 180);
camera.up.set(0, 0, 1); // use Z-up so orbiting spins around machine Z instead of world Y

const controls = new TrackballControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.rotateSpeed = 4.0;
controls.zoomSpeed = 1.2;
controls.panSpeed = 0.8;
controls.noRoll = false; // allow roll
controls.staticMoving = false;
controls.dynamicDampingFactor = 0.15;
controls.update();

function setHomeView() {
  camera.up.set(0, 0, 1);
  camera.position.set(0, -320, 180);
  controls.target.set(0, 0, 0);
  controls.update();
}

scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.8));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
dirLight.position.set(300, 300, 250);
scene.add(dirLight);

// Visualization frame for grid/axes/labels so we can orient the graph without touching the machine.
const vizFrame = new THREE.Group();
vizFrame.name = "viz_frame";
// Keep grid in XY plane for clarity; rotate here if you need a different view basis.
vizFrame.rotation.set(0, 0, 0);
scene.add(vizFrame);

const gridSize = 2500;
const grid = new THREE.GridHelper(gridSize, 25, 0x335577, 0x1c2a3a);
grid.rotation.x = Math.PI / 2; // default GridHelper is XZ; rotate to XY (Z-up)
vizFrame.add(grid);

const worldAxes = new THREE.AxesHelper(120);
vizFrame.add(worldAxes);

const axisLabelGroup = new THREE.Group();
axisLabelGroup.name = "axis_labels";
function updateWorldAxisLabels() {
  while (axisLabelGroup.children.length > 0) {
    axisLabelGroup.remove(axisLabelGroup.children[0]);
  }

  const edge = gridSize * 0.5;
  const labels = [
    { text: "X+", pos: new THREE.Vector3(-edge, 0, 0), color: "#ff5555" },
    { text: "Y+", pos: new THREE.Vector3(0, edge, 0), color: "#55ff55" },
    { text: "Z+", pos: new THREE.Vector3(0, 0, edge), color: "#5599ff" },
  ];
  for (const entry of labels) {
    const sprite = createLabelSprite(entry.text, entry.color);
    if (!sprite) continue;
    sprite.position.copy(entry.pos);
    sprite.material.depthTest = true; // allow labels to be occluded by geometry
    sprite.material.depthWrite = false;
    sprite.renderOrder = 0;
    sprite.scale.set(40, 40, 1);
    axisLabelGroup.add(sprite);
  }
}

updateWorldAxisLabels();
vizFrame.add(axisLabelGroup);

const machineRoot = new THREE.Group();
scene.add(machineRoot);

const vrmlLoader = new VRMLLoader();
const nodeState = new Map();
const nodeMeshGroups = new Map();
const nodeMeshRotOverrides = new Map();
const nodeMeshPosOverrides = new Map();
let hierarchyReady = false;
let meshMounts = {};
let kinematicsInputs = {};
let calibrationCfg = {};
let blankCfg = {};
let wheelCfg = {};
let machineBasisQ = new THREE.Quaternion();

const unitX = new THREE.Vector3(1, 0, 0);

function parseCfgNumeric(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const noComment = raw.replace(/#.*/, "").trim();
    if (!noComment) continue;
    const eq = noComment.indexOf("=");
    if (eq < 0) continue;
    const key = noComment.slice(0, eq).trim();
    const value = Number.parseFloat(noComment.slice(eq + 1).trim());
    if (!key || !Number.isFinite(value)) continue;
    result[key] = value;
  }
  return result;
}

/** Parse cfg file keeping ALL values — numeric as numbers, everything else as trimmed strings. */
function parseCfgAll(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const noComment = raw.replace(/#.*/, "").trim();
    if (!noComment) continue;
    const eq = noComment.indexOf("=");
    if (eq < 0) continue;
    const key = noComment.slice(0, eq).trim();
    const valStr = noComment.slice(eq + 1).trim();
    if (!key) continue;
    const num = Number.parseFloat(valStr);
    result[key] = Number.isFinite(num) ? num : valStr;
  }
  return result;
}

async function tryLoadCfg(path) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) return {};
    const text = await response.text();
    return parseCfgNumeric(text);
  } catch (_) {
    return {};
  }
}

function configuredSpindleAxisDirection() {
  if (hierarchyReady && nodeState?.has("spindle")) {
    const spindleGroup = nodeState.get("spindle")?.dynamicGroup;
    if (spindleGroup) {
      const worldAxis = new THREE.Vector3(0, -1, 0).applyQuaternion(spindleGroup.getWorldQuaternion(new THREE.Quaternion()));
      const invBasis = machineBasisQ.clone().invert();
      const machineAxis = worldAxis.applyQuaternion(invBasis);
      if (machineAxis.lengthSq() > 1e-9) return machineAxis.normalize();
    }
  }
  const v = meshMounts?.spindleAxisDirection;
  if (!Array.isArray(v) || v.length < 3) {
    return new THREE.Vector3(1, 0, 0);
  }
  const dir = new THREE.Vector3(Number(v[0] || 0), Number(v[1] || 0), Number(v[2] || 0));
  if (dir.lengthSq() < 1e-9) return new THREE.Vector3(1, 0, 0);
  dir.normalize();
  return dir;
}

function configuredAAxisZeroQuaternion() {
  const r = meshMounts?.aAxisZeroAngleDegXyz;
  if (!Array.isArray(r) || r.length < 3) {
    return eulerQuaternionFromDegXYZ(0, 0, 90);
  }
  return eulerQuaternionFromDegXYZ(Number(r[0] || 0), Number(r[1] || 0), Number(r[2] || 0));
}

function configuredMachineBasisQuaternion() {
  const r = meshMounts?.machineBasisRotationDegXyz;
  if (Array.isArray(r) && r.length >= 3) {
    return eulerQuaternionFromDegXYZ(Number(r[0] || 0), Number(r[1] || 0), Number(r[2] || 0));
  }
  return eulerQuaternionFromDegXYZ(-90, 0, 180);
}

function updateBasisUiFromConfig() {
  const r = meshMounts?.machineBasisRotationDegXyz;
  if (!Array.isArray(r) || r.length < 3) return;
  if (ui.basisRx) ui.basisRx.value = String(Number(r[0] || 0));
  if (ui.basisRy) ui.basisRy.value = String(Number(r[1] || 0));
  if (ui.basisRz) ui.basisRz.value = String(Number(r[2] || 0));
}

function machineBasisQuaternionFromUi() {
  const rx = ui.basisRx ? numberInputValue(ui.basisRx, 0) : 0;
  const ry = ui.basisRy ? numberInputValue(ui.basisRy, 0) : 0;
  const rz = ui.basisRz ? numberInputValue(ui.basisRz, 0) : 0;
  return eulerQuaternionFromDegXYZ(rx, ry, rz);
}

function applyBasisRotation() {
  machineBasisQ = machineBasisQuaternionFromUi();
  machineRoot.quaternion.copy(machineBasisQ);
  const settings = collectTransformSettings();
  rebuildTrail(state.frames, settings);
  applyFrame(state.frameIndex);
}

function applyNodeRotation() {
  const nodeName = ui.nodeSelect?.value;
  if (!nodeName || !nodeMeshGroups.has(nodeName)) return;

  const rx = ui.nodeRx ? numberInputValue(ui.nodeRx, 0) : 0;
  const ry = ui.nodeRy ? numberInputValue(ui.nodeRy, 0) : 0;
  const rz = ui.nodeRz ? numberInputValue(ui.nodeRz, 0) : 0;
  const tx = ui.nodeTx ? numberInputValue(ui.nodeTx, 0) : 0;
  const ty = ui.nodeTy ? numberInputValue(ui.nodeTy, 0) : 0;
  const tz = ui.nodeTz ? numberInputValue(ui.nodeTz, 0) : 0;
  const uiWorldTranslation = new THREE.Vector3(tx, ty, tz);
  const worldTranslation = uiWorldToSceneWorldTranslation(uiWorldTranslation);
  const localTranslation = worldToLocalMeshTranslation(nodeName, worldTranslation);

  nodeMeshRotOverrides.set(nodeName, { rx, ry, rz });
  nodeMeshPosOverrides.set(nodeName, {
    tx: localTranslation.x,
    ty: localTranslation.y,
    tz: localTranslation.z,
  });
  applyMeshPoseForNode(nodeName);

  const settings = collectTransformSettings();
  rebuildTrail(state.frames, settings);
  applyFrame(state.frameIndex);
}

function setNodeRotationInputs(rx, ry, rz) {
  if (ui.nodeRx) ui.nodeRx.value = String(rx);
  if (ui.nodeRy) ui.nodeRy.value = String(ry);
  if (ui.nodeRz) ui.nodeRz.value = String(rz);
  if (ui.nodeRxSlider) ui.nodeRxSlider.value = String(rx);
  if (ui.nodeRySlider) ui.nodeRySlider.value = String(ry);
  if (ui.nodeRzSlider) ui.nodeRzSlider.value = String(rz);
}

function setNodeTranslationInputs(tx, ty, tz) {
  if (ui.nodeTx) ui.nodeTx.value = String(tx);
  if (ui.nodeTy) ui.nodeTy.value = String(ty);
  if (ui.nodeTz) ui.nodeTz.value = String(tz);
}

function meshParentWorldQuaternion(nodeName) {
  const meshGroup = nodeMeshGroups.get(nodeName);
  const q = new THREE.Quaternion();
  if (!meshGroup || !meshGroup.parent) return q;
  scene.updateMatrixWorld(true);
  meshGroup.parent.getWorldQuaternion(q);
  return q;
}

function worldToLocalMeshTranslation(nodeName, worldTranslation) {
  const parentWorldQ = meshParentWorldQuaternion(nodeName);
  return worldTranslation.clone().applyQuaternion(parentWorldQ.clone().invert());
}

function localToWorldMeshTranslation(nodeName, localTranslation) {
  const parentWorldQ = meshParentWorldQuaternion(nodeName);
  return localTranslation.clone().applyQuaternion(parentWorldQ);
}

function uiWorldToSceneWorldTranslation(translation) {
  return new THREE.Vector3(-translation.x, translation.y, translation.z);
}

function sceneWorldToUiWorldTranslation(translation) {
  return new THREE.Vector3(-translation.x, translation.y, translation.z);
}

function syncSelectedNodePoseInputs() {
  const nodeName = ui.nodeSelect?.value;
  if (!nodeName) return;

  const rot = nodeMeshRotOverrides.get(nodeName) || { rx: 0, ry: 0, rz: 0 };
  const localPos = nodeMeshPosOverrides.get(nodeName) || { tx: 0, ty: 0, tz: 0 };
  const worldPos = localToWorldMeshTranslation(
    nodeName,
    new THREE.Vector3(localPos.tx, localPos.ty, localPos.tz)
  );
  const uiWorldPos = sceneWorldToUiWorldTranslation(worldPos);

  setNodeRotationInputs(rot.rx, rot.ry, rot.rz);
  setNodeTranslationInputs(uiWorldPos.x, uiWorldPos.y, uiWorldPos.z);
}

function linkRotationInputPair(numberInput, sliderInput) {
  if (!numberInput || !sliderInput) return;
  numberInput.addEventListener("change", () => {
    sliderInput.value = String(numberInputValue(numberInput, Number(sliderInput.value) || 0));
  });
  sliderInput.addEventListener("input", () => {
    numberInput.value = sliderInput.value;
  });
}

function axisAlignQuaternion(axisDirection) {
  const q = new THREE.Quaternion();
  q.setFromUnitVectors(unitX, axisDirection);
  return q;
}

function spindleMountDistanceMm() {
  const aAxisLen = Number(calibrationCfg.aAxisBarLengthToAAxisFaceMm || 0);
  return Math.max(0, aAxisLen);
}

function wheelMountDistanceMm() {
  const spindleMountDistance = spindleMountDistanceMm();
  const spindleDiskLength = Number(calibrationCfg.spindleDiskLengthFromSpindleMountMm || 0);
  return spindleMountDistance + Math.max(0, spindleDiskLength);
}

function meshUnitScaleValue() {
  const configured = Number(meshMounts?.meshUnitScale);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return 1.0;
}

function legacyMeshOverridesEnabled() {
  return meshMounts?.enableLegacyMeshOverrides === true;
}

function addFallbackAxisAndSpindle(parent) {
  const axisMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(12, 12, 70, 32),
    new THREE.MeshStandardMaterial({ color: 0x7aa2ff })
  );
  axisMesh.rotation.z = Math.PI / 2;
  axisMesh.position.set(0, 0, 0);
  parent.add(axisMesh);

  const spindleMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(8, 8, 80, 32),
    new THREE.MeshStandardMaterial({ color: 0xc0c0c0 })
  );
  spindleMesh.rotation.z = Math.PI / 2;
  spindleMesh.position.set(40, 0, 0);
  parent.add(spindleMesh);
}

function addAxisFallbackBox(parent, color, size = [30, 30, 30]) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({ color, wireframe: true })
  );
  parent.add(mesh);
  return mesh;
}

function addAlignmentProxyBox(parent, color, size = [50, 20, 20]) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      wireframe: false,
    })
  );
  parent.add(mesh);
  return mesh;
}

function createLabelSprite(text, colorHex = "#ffffff") {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  ctx.fillStyle = colorHex;
  ctx.font = "bold 48px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(10, 10, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function orthonormalBasisFromAxis(axis) {
  const n = axis.clone().normalize();
  const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(n, ref).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, v, n };
}

function addAxisTextLabel(parent, text, position, colorHex) {
  const sprite = createLabelSprite(text, colorHex);
  if (!sprite) return;
  sprite.position.copy(position);
  sprite.scale.set(40, 40, 1);
  parent.add(sprite);
}

function addPivotMarker(parent, color, label) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(6, 16, 16),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 })
  );
  parent.add(marker);

  const axes = new THREE.AxesHelper(50);
  parent.add(axes);

  const sprite = createLabelSprite(label, "#ffffff");
  if (sprite) {
    sprite.position.set(0, 0, 32);
    sprite.scale.set(40, 40, 1);
    parent.add(sprite);
  }
}

function addLinearAxisDirectionArrows(parent, axisName, axisVector, color, colorHex) {
  const origin = new THREE.Vector3(0, 0, 0);
  const dir = axisVector.clone().normalize();
  const length = 260;
  const headLength = 32;
  const headWidth = 20;

  const plusArrow = new THREE.ArrowHelper(dir, origin, length, color, headLength, headWidth);
  const minusArrow = new THREE.ArrowHelper(dir.clone().negate(), origin, length, color, headLength, headWidth);
  parent.add(plusArrow);
  parent.add(minusArrow);

  addAxisTextLabel(parent, `${axisName}+`, dir.clone().multiplyScalar(length + 70), colorHex);
  addAxisTextLabel(parent, `${axisName}-`, dir.clone().multiplyScalar(-(length + 70)), colorHex);
}

function addRotaryAxisDirectionArrows(parent, axisName, axisVector, color, colorHex) {
  const { u, v } = orthonormalBasisFromAxis(axisVector);
  const radius = 170;
  const tangentLen = 95;
  const headLength = 26;
  const headWidth = 16;

  const plusOrigin = u.clone().multiplyScalar(radius);
  const plusDir = v.clone().normalize();
  const plusArrow = new THREE.ArrowHelper(plusDir, plusOrigin, tangentLen, color, headLength, headWidth);
  parent.add(plusArrow);
  addAxisTextLabel(parent, `${axisName}+`, plusOrigin.clone().add(plusDir.clone().multiplyScalar(tangentLen + 50)), colorHex);

  const minusOrigin = u.clone().multiplyScalar(-radius);
  const minusDir = v.clone().normalize();
  const minusArrow = new THREE.ArrowHelper(minusDir, minusOrigin, tangentLen, color, headLength, headWidth);
  parent.add(minusArrow);
  addAxisTextLabel(parent, `${axisName}-`, minusOrigin.clone().add(minusDir.clone().multiplyScalar(tangentLen + 50)), colorHex);
}

function addWrlMesh(url, color, parent, onObjectLoaded, fallback = null) {
  vrmlLoader.load(
    url,
    (object) => {
      const meshEntries = [];
      object.traverse((child) => {
        if (!child.isMesh) return;
        if (!child.geometry) return;
        child.geometry.computeBoundingBox();
        child.geometry.computeBoundingSphere();
        const radius = child.geometry.boundingSphere?.radius ?? 0;
        meshEntries.push({ child, radius });

        const sourceMaterial = child.material;
        const material = Array.isArray(sourceMaterial) ? sourceMaterial[0] : sourceMaterial;
        if (material && material.color) {
          material.color.setHex(color);
        }
        if (material) {
          material.transparent = true;
          material.opacity = 1.0;
          material.side = THREE.DoubleSide;
        }
      });

      const validRadii = meshEntries
        .map((entry) => entry.radius)
        .filter((radius) => Number.isFinite(radius) && radius > 0)
        .sort((a, b) => a - b);

      if (validRadii.length > 2) {
        const medianRadius = validRadii[Math.floor(validRadii.length / 2)];
        const absoluteCap = 1200;
        const relativeCap = medianRadius * 8.0;
        const outlierLimit = Math.max(absoluteCap, relativeCap);

        for (const entry of meshEntries) {
          if (!Number.isFinite(entry.radius) || entry.radius <= outlierLimit) continue;
          if (entry.child.parent) {
            entry.child.parent.remove(entry.child);
          }
        }
      }

      object.scale.setScalar(meshUnitScaleValue());

      if (onObjectLoaded) {
        onObjectLoaded(object);
      }
      parent.add(object);
    },
    undefined,
    () => {
      if (fallback) {
        fallback(parent);
      }
    }
  );
}

function shouldRenderNodeMesh(nodeName) {
  const visible = meshMounts?.visibleNodeMeshes;
  if (!Array.isArray(visible) || visible.length === 0) {
    return true;
  }
  return visible.includes(nodeName);
}

function nodeWrlPath(nodeName) {
  const node = nodeState.get(nodeName)?.node;
  const geometry = node?.geometry;
  if (typeof geometry !== "string") return null;
  if (!geometry.toLowerCase().endsWith(".wrl")) return null;
  return `/data/${geometry}`;
}

function addNodeWrlMesh(nodeName, color, parent, onLoaded, fallback = null) {
  const wrlPath = nodeWrlPath(nodeName);
  if (!wrlPath) {
    if (fallback) fallback(parent);
    return;
  }
  addWrlMesh(wrlPath, color, parent, onLoaded, fallback);
}

function buildBlankMesh(parent) {
  try {
  console.warn(`[blank] ENTER buildBlankMesh — blankCfg=${JSON.stringify(blankCfg)} calibKeys=${Object.keys(calibrationCfg)}`);
  const diameter = Number(blankCfg.blankDiameterMm || calibrationCfg.aAxisBarDiameterMm || 20.0);
  const blankLength = Number(blankCfg.blankLengthMm || 100);
  const faceFromAAxisFace = Number(blankCfg.blankLengthFromAAxisFaceMm || 30);
  const faceOffset = Number(calibrationCfg.aAxisFaceOffsetMm || 150);

  // a_axis origin = C-axis pivot. Face = faceOffset BEHIND pivot (toward -barDir).
  // Blank sticks out from face toward +barDir (toward operator at C=0).
  // Tip = -faceOffset + faceFromAAxisFace along barDir.
  const settings = collectTransformSettings();
  const barDir = settings.axisDirections.a.clone().normalize();

  const tipDist = -faceOffset + faceFromAAxisFace;
  const centerDist = tipDist - blankLength / 2;
  const centerOffset = barDir.clone().multiplyScalar(centerDist);

  console.warn(`[blank] barDir=(${barDir.x},${barDir.y},${barDir.z}) tipDist=${tipDist} centerDist=${centerDist} centerOffset=(${centerOffset.x.toFixed(1)},${centerOffset.y.toFixed(1)},${centerOffset.z.toFixed(1)})`);

  const blank = new THREE.Mesh(
    new THREE.CylinderGeometry(diameter * 0.5, diameter * 0.5, blankLength, 32),
    new THREE.MeshStandardMaterial({ color: 0xffd18a })
  );
  blank.name = "workpiece_blank";
  const cylDefault = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(cylDefault, barDir);
  blank.quaternion.copy(q);
  const yNudge = configuredSpindleAxisDirection().multiplyScalar(VIEWER_BLANK_Y_NUDGE_MM);
  blank.position.copy(centerOffset).add(yNudge);
  console.warn(`[blank] yNudge=(${yNudge.x.toFixed(1)},${yNudge.y.toFixed(1)},${yNudge.z.toFixed(1)}) blankPos=(${blank.position.x.toFixed(1)},${blank.position.y.toFixed(1)},${blank.position.z.toFixed(1)})`);
  parent.add(blank);

  console.warn(`[blank] Mesh added to parent: ${parent.name}`);
  } catch (err) {
    console.error(`[blank] ERROR in buildBlankMesh:`, err);
  }
}

function buildFallbackWheelMesh(parent) {
  const axisDirection = configuredSpindleAxisDirection();
  const distance = wheelMountDistanceMm();
  const wheel = new THREE.Mesh(
    new THREE.TorusGeometry(16, 5, 24, 64),
    new THREE.MeshStandardMaterial({ color: 0x8899aa })
  );
  const q = axisAlignQuaternion(axisDirection);
  wheel.quaternion.copy(q.multiply(eulerQuaternionFromDegXYZ(0, 90, 0)));
  wheel.position.copy(axisDirection.multiplyScalar(distance));
  parent.add(wheel);
}

/**
 * Build proper wheel-pack meshes from wheel.cfg definitions.
 * Wheel 1: 11V9 flaring cup — cone frustum, sharp edge (large OD) at -Z (operator).
 * Wheel 2: 1A1 straight cylinder — flat disc, back face (+Z) grinds.
 * Both are rotationally symmetric around the spindle axis.
 */
/**
 * Build wheel meshes from wheel.cfg definitions.
 *
 * OFFSET DEFINITION:
 *   YOffsetMm = distance from spindle face to the GRIND FACE of that wheel.
 *   The wheel body extends away from the grind face along the spindle shaft.
 *
 * GRIND SIDE:
 *   GrindSide = +y → grind face points toward +Y (back of machine / spindle column)
 *                     body extends in -Y (toward operator)
 *   GrindSide = -y → grind face points toward -Y (toward operator)
 *                     body extends in +Y (toward spindle column)
 *
 * A red ring marks each grind face for visual confirmation.
 */
function buildWheelPackMeshes(parent) {
  parent.quaternion.identity();
  // Position wheels at the spindle mount face.
  // mesh_translations_mm for "spindle" positions the bore register at the kinematic ref.
  // HARD-CODED — DO NOT CHANGE without operator verification.
  // flangeNudgeMm = -(spindle_face_wrl_y + child_cy) = -(12 + (−31)) = +19.
  // WRL Y≈12 = spindle arbor-seating face (flat annular face behind the Y=30 boss).
  // Derived from spindle.wrl vertex radius-band profiling + operator visual confirmation.
  // This is a LOCAL offset within the spindle mesh; moving the whole spindle
  // (mesh_translations_mm) does NOT require changing this value.
  const spMeshPos = nodeMeshPosOverrides.get("spindle") || { tx: 0, ty: 0, tz: 0 };
  const flangeNudgeMm = 19; // LOCKED — verified 2026-03-02
  parent.position.set(spMeshPos.tx, spMeshPos.ty + flangeNudgeMm, spMeshPos.tz);

  const axisDir = configuredSpindleAxisDirection(); // [0,1,0]
  const cylDefault = new THREE.Vector3(0, 1, 0);

  // ── DEBUG: Purple ring at flange face (Y=0 = YOffsetMm=0 reference) ──
  const refRingPurple = new THREE.Mesh(
    new THREE.RingGeometry(75, 80, 64),
    new THREE.MeshBasicMaterial({ color: 0xcc00ff, side: THREE.DoubleSide })
  );
  refRingPurple.name = "ref_flange_face";
  refRingPurple.rotation.x = -Math.PI / 2;
  refRingPurple.position.set(0, 0, 0); // at parent origin = flange face
  parent.add(refRingPurple);

  console.warn(`[wheels] PURPLE ring = flange face (Y=0 in parent = YOffsetMm=0 reference).`);

  // Helper: add a red ring at the grind face for visual confirmation
  function addGrindRing(parentMesh, radius, faceLocalY) {
    const ringGeo = new THREE.RingGeometry(radius * 0.85, radius, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.name = "grind_face_marker";
    // RingGeometry default normal is +Z; rotate -90° around X so normal points along +Y (cylinder axis)
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, faceLocalY, 0);
    parentMesh.add(ring);
  }

  // ── Wheel 1: 11V9 cone ───────────────────────────────────
  const w1od    = Number(wheelCfg.wheel1ODMm || 110);
  const w1r     = w1od / 2;
  const w1taper = Number(wheelCfg.wheel1TaperAngleDeg || 20);
  const w1face  = Number(wheelCfg.wheel1ActiveFaceMm || 25);
  const w1yOff  = Number(wheelCfg.wheel1YOffsetMm || 100);
  const w1gs    = String(wheelCfg.wheel1GrindSide || "-y").trim().toLowerCase();
  const w1rSmall = Math.max(0.5, w1r - w1face * Math.tan(w1taper * Math.PI / 180));

  // CylinderGeometry: radiusTop = +Y half, radiusBottom = -Y half.
  // 11V9 cup: large OD at sharp/grind edge, small at hub.
  // grindSide=-y → grind face at -Y end → large radius at bottom (radiusBottom=w1r)
  //                body extends toward +Y → center shifted toward +Y from grind face
  // grindSide=+y → grind face at +Y end → large radius at top (radiusTop=w1r)
  //                body extends toward -Y → center shifted toward -Y from grind face
  const w1grindAtMinusY = (w1gs === "-y");
  const w1geo = w1grindAtMinusY
    ? new THREE.CylinderGeometry(w1rSmall, w1r, w1face, 64, 1, true)   // top=small, bot=large
    : new THREE.CylinderGeometry(w1r, w1rSmall, w1face, 64, 1, true);  // top=large, bot=small
  const w1mat = new THREE.MeshStandardMaterial({
    color: 0xff8800, wireframe: true, side: THREE.DoubleSide,
  });
  const w1mesh = new THREE.Mesh(w1geo, w1mat);
  w1mesh.name = "wheel1_11V9";

  // Position: grind face at -YOffsetMm from spindle face (along -axisDir toward operator).
  // Body extends face/2 further from the grind point, away from articular direction.
  const w1bodyDir = w1grindAtMinusY ? +1 : -1; // body extends opposite to grind face
  const w1centerY = -(w1yOff) + w1bodyDir * (w1face / 2);
  w1mesh.position.copy(axisDir.clone().multiplyScalar(w1centerY));
  parent.add(w1mesh);

  // Grind ring at the grind face edge of the cylinder
  const w1grindLocalY = w1grindAtMinusY ? -w1face / 2 : +w1face / 2;
  addGrindRing(w1mesh, w1r, w1grindLocalY);

  // ── Wheel 2: 1A1 cylinder ────────────────────────────────
  const w2od   = Number(wheelCfg.wheel2ODMm || 125);
  const w2r    = w2od / 2;
  const w2w    = Number(wheelCfg.wheel2WidthMm || 12);
  const w2yOff = Number(wheelCfg.wheel2YOffsetMm || 1);
  const w2gs   = String(wheelCfg.wheel2GrindSide || "+y").trim().toLowerCase();

  const w2geo = new THREE.CylinderGeometry(w2r, w2r, w2w, 64);
  const w2mat = new THREE.MeshStandardMaterial({
    color: 0x00ccff, wireframe: true,
  });
  const w2mesh = new THREE.Mesh(w2geo, w2mat);
  w2mesh.name = "wheel2_1A1";

  // grindSide=+y → grind face at +Y end (back of machine, toward spindle)
  //                body extends toward -Y (toward operator)
  // grindSide=-y → grind face at -Y end (toward operator)
  //                body extends toward +Y (toward spindle)
  const w2grindAtPlusY = (w2gs === "+y");
  const w2bodyDir = w2grindAtPlusY ? -1 : +1; // body extends opposite to grind face
  const w2centerY = -(w2yOff) + w2bodyDir * (w2w / 2);
  w2mesh.position.copy(axisDir.clone().multiplyScalar(w2centerY));
  parent.add(w2mesh);

  const w2grindLocalY = w2grindAtPlusY ? +w2w / 2 : -w2w / 2;
  addGrindRing(w2mesh, w2r, w2grindLocalY);

  console.warn(
    `[wheels] W1 11V9: OD=${w1od} face=${w1face}mm grindSide=${w1gs} offset=${w1yOff}mm centerY=${w1centerY.toFixed(1)}` +
    ` | W2 1A1: OD=${w2od} w=${w2w}mm grindSide=${w2gs} offset=${w2yOff}mm centerY=${w2centerY.toFixed(1)}`
  );
}

function clearMachineTree() {
  while (machineRoot.children.length > 0) {
    machineRoot.remove(machineRoot.children[0]);
  }
  nodeState.clear();
  nodeMeshGroups.clear();
  nodeMeshRotOverrides.clear();
  nodeMeshPosOverrides.clear();
  hierarchyReady = false;
}

function createNodeObjects(node) {
  const staticGroup = new THREE.Group();
  staticGroup.name = `${node.name}_static`;

  const dynamicGroup = new THREE.Group();
  dynamicGroup.name = `${node.name}_dynamic`;
  staticGroup.add(dynamicGroup);

  const transform = node.transform || {};
  const tr = transform.translation || [0, 0, 0];
  const rot = transform.rotation_deg_xyz || [0, 0, 0];
  const baseRot = { rx: Number(rot[0] || 0), ry: Number(rot[1] || 0), rz: Number(rot[2] || 0) };
  const meshRot = nodeMeshRotationOverrideFromKinematics(node.name) || { rx: 0, ry: 0, rz: 0 };
  const meshPos = nodeMeshTranslationOverrideFromKinematics(node.name) || { tx: 0, ty: 0, tz: 0 };

  staticGroup.position.set(Number(tr[0] || 0), Number(tr[1] || 0), Number(tr[2] || 0));
  staticGroup.quaternion.copy(eulerQuaternionFromDegXYZ(baseRot.rx, baseRot.ry, baseRot.rz));
  staticGroup.userData.basePosition = staticGroup.position.clone();
  nodeMeshRotOverrides.set(node.name, meshRot);
  nodeMeshPosOverrides.set(node.name, meshPos);

  nodeState.set(node.name, { node, staticGroup, dynamicGroup });
  return { staticGroup, dynamicGroup };
}

function attachGeometryByNode(nodeName, dynamicGroup) {
  const settings = collectTransformSettings();
  const meshGroup = new THREE.Group();
  meshGroup.name = `${nodeName}_mesh`;
  dynamicGroup.add(meshGroup);
  nodeMeshGroups.set(nodeName, meshGroup);
  applyMeshPoseForNode(nodeName);

  const renderNodeMesh = shouldRenderNodeMesh(nodeName);
  if (!renderNodeMesh && nodeName !== "y_axis" && nodeName !== "z_axis" && nodeName !== "a_axis") {
    return;
  }

  if (nodeName === "base") {
    addNodeWrlMesh("base", 0xb0b080, meshGroup, (object) => {
      object.position.set(0, 0, 0);
    });
    return;
  }

  if (nodeName === "x_axis") {
    if (meshMounts?.hideStaticXMesh !== true) {
      addNodeWrlMesh("x_axis", 0x2ec4ff, meshGroup, (object) => {
        object.position.set(0, 0, 0);
      }, (parent) => {
        addAxisFallbackBox(parent, 0x2ec4ff, [180, 20, 20]);
      });
    }

    if (meshMounts?.showMovingXMesh !== false) {
      const xDynamicGroup = nodeState.get("x_axis")?.dynamicGroup;
      if (xDynamicGroup) {
        const xMovingMeshGroup = new THREE.Group();
        xMovingMeshGroup.name = "x_axis_moving_mesh";
        xDynamicGroup.add(xMovingMeshGroup);
        addWrlMesh("/data/swing_workhead.wrl", 0xff7f50, xMovingMeshGroup, (object) => {
          object.position.set(0, 0, 0);
          object.rotation.z = Math.PI;
        });
      }
    }

    addLinearAxisDirectionArrows(
      dynamicGroup,
      "X",
      settings.axisDirections.x.clone().multiplyScalar(settings.signs.x),
      0x2ec4ff,
      "#2ec4ff"
    );
    return;
  }
  if (nodeName === "y_axis") {
    if (renderNodeMesh) {
      addNodeWrlMesh("y_axis", 0x6de07a, meshGroup, (object) => {
        object.position.set(0, 0, 0);
      }, (parent) => {
        addAxisFallbackBox(parent, 0x6de07a, [160, 22, 22]);
      });
    }
    addLinearAxisDirectionArrows(
      dynamicGroup,
      "Y",
      settings.axisDirections.y.clone().multiplyScalar(settings.signs.y),
      0x6de07a,
      "#6de07a"
    );
    return;
  }
  if (nodeName === "z_axis") {
    if (renderNodeMesh) {
      addNodeWrlMesh("z_axis", 0xa58bff, meshGroup, (object) => {
        object.position.set(0, 0, 0);
      }, (parent) => {
        addAxisFallbackBox(parent, 0xa58bff, [160, 22, 22]);
      });
    }
    addLinearAxisDirectionArrows(
      dynamicGroup,
      "Z",
      settings.axisDirections.z.clone().multiplyScalar(settings.signs.z),
      0xa58bff,
      "#a58bff"
    );
    return;
  }
  if (nodeName === "c_axis") {
    addNodeWrlMesh("c_axis", 0x00ff00, meshGroup, (object) => {
      object.position.set(0, 0, 0);
    }, (parent) => {
      addAxisFallbackBox(parent, 0xff7f50, [120, 120, 25]);
    });
    addRotaryAxisDirectionArrows(
      dynamicGroup,
      "C",
      settings.axisDirections.c.clone().multiplyScalar(settings.signs.c),
      0xff7f50,
      "#ff7f50"
    );
    return;
  }
  if (nodeName === "a_axis") {
    // a_axis origin IS the a-axis face (kinematic translation already applied).
    // a_axis origin = rotation center. Face = origin + aAxisBarLen along barDir.
    {
      const faceOffset = Number(calibrationCfg.aAxisFaceOffsetMm || 127.55);
      const barDir = settings.axisDirections.a.clone().normalize();
      const barRadius = 8;

      // Yellow ring at the a-axis FACE = -faceOffset along barDir from pivot
      const faceRing = new THREE.Mesh(
        new THREE.RingGeometry(barRadius, barRadius + 4, 32),
        new THREE.MeshBasicMaterial({ color: 0xffff00, side: THREE.DoubleSide })
      );
      faceRing.name = "a_axis_face_ring";
      faceRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), barDir);
      faceRing.position.copy(barDir.clone().multiplyScalar(-faceOffset));
      dynamicGroup.add(faceRing);
    }
    addRotaryAxisDirectionArrows(
      dynamicGroup,
      "A",
      settings.axisDirections.a.clone().multiplyScalar(settings.signs.a),
      0x7aa2ff,
      "#7aa2ff"
    );
    buildBlankMesh(dynamicGroup);
    return;
  }
  if (nodeName === "spindle") {
    addNodeWrlMesh("spindle", 0xc0c0c0, meshGroup, (object) => {
      // STP-derived child offset: WRL bore register (R≈110) at WRL origin (0,0,0).
      //   cx = 0 : bore coaxiality — bore axis at WRL X=0, shaft centered at X=0.
      //   cz = 0 : bore coaxiality — bore axis at WRL Z=0, shaft centered at Z=0.
      //   cy = -31: D=150.16mm disk bore-side face at WRL Y≈43 (R≈75 ring onset),
      //            cy = (mesh_ty − green_ring_world_y) − disk_face_y = 12 − 43 = −31.
      // Bore world X = −(cx) + mesh_tx = 0 + (−85) = −85 = green ring X. ✓ Coaxial.
      object.position.set(0, -31, 0);
    });
    return;
  }
  if (nodeName === "wheel") {
    if (wheelCfg.wheel1ODMm || wheelCfg.wheel2ODMm) {
      buildWheelPackMeshes(meshGroup);
    } else {
      addNodeWrlMesh("wheel", 0x8899aa, meshGroup, null, buildFallbackWheelMesh);
    }
  }
}

async function loadMeshMounts() {
  try {
    const response = await fetch("./mesh_mounts.json", { cache: "no-store" });
    if (!response.ok) {
      return;
    }
    meshMounts = await response.json();
  } catch (_) {
    meshMounts = {};
  }
}

async function loadCalibrationInputs() {
  calibrationCfg = await tryLoadCfg("/cfg/calibration_inputs.cfg");
}

async function loadBlankInputs() {
  blankCfg = await tryLoadCfg("/cfg/blank.cfg");
}

async function loadToolInputs() {
  toolCfg = await tryLoadCfg("/cfg/tool_2flute.cfg");
}

async function loadWheelInputs() {
  try {
    const response = await fetch("/cfg/wheel.cfg", { cache: "no-store" });
    if (!response.ok) { wheelCfg = {}; return; }
    const text = await response.text();
    wheelCfg = parseCfgAll(text);
    console.warn("[wheels] wheel.cfg loaded:", JSON.stringify(wheelCfg));
  } catch (_) {
    wheelCfg = {};
  }
}

async function loadKinematicsInputs() {
  try {
    const response = await fetch("/data/kinematics_inputs.json", { cache: "no-store" });
    if (!response.ok) {
      kinematicsInputs = {};
      return;
    }
    kinematicsInputs = await response.json();
  } catch (_) {
    kinematicsInputs = {};
  }
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function setVectorInputTriplet(inputTriplet, vector) {
  if (!inputTriplet || !Array.isArray(vector) || vector.length < 3) return;
  const x = Number(vector[0]);
  const y = Number(vector[1]);
  const z = Number(vector[2]);
  if (isFiniteNumber(x) && inputTriplet.dx) inputTriplet.dx.value = String(x);
  if (isFiniteNumber(y) && inputTriplet.dy) inputTriplet.dy.value = String(y);
  if (isFiniteNumber(z) && inputTriplet.dz) inputTriplet.dz.value = String(z);
}

function applyKinematicsInputsToUi() {
  const directions = kinematicsInputs?.axis_directions || {};
  setVectorInputTriplet(axisDirectionInputs.x, directions.x_axis);
  setVectorInputTriplet(axisDirectionInputs.y, directions.y_axis);
  setVectorInputTriplet(axisDirectionInputs.z, directions.z_axis);
  setVectorInputTriplet(axisDirectionInputs.c, directions.c_axis);
  setVectorInputTriplet(axisDirectionInputs.a, directions.a_axis);

  const signs = kinematicsInputs?.axis_signs || {};
  if (isFiniteNumber(signs.x) && signInputs.x) signInputs.x.value = String(Math.sign(Number(signs.x)) || 1);
  if (isFiniteNumber(signs.y) && signInputs.y) signInputs.y.value = String(Math.sign(Number(signs.y)) || 1);
  if (isFiniteNumber(signs.z) && signInputs.z) signInputs.z.value = String(Math.sign(Number(signs.z)) || 1);
  if (isFiniteNumber(signs.a) && signInputs.a) signInputs.a.value = String(Math.sign(Number(signs.a)) || 1);
  if (isFiniteNumber(signs.c) && signInputs.c) signInputs.c.value = String(Math.sign(Number(signs.c)) || 1);

  const offsets = kinematicsInputs?.axis_offsets || {};
  if (isFiniteNumber(offsets.x) && offsetInputs.x) offsetInputs.x.value = String(Number(offsets.x));
  if (isFiniteNumber(offsets.y) && offsetInputs.y) offsetInputs.y.value = String(Number(offsets.y));
  if (isFiniteNumber(offsets.z) && offsetInputs.z) offsetInputs.z.value = String(Number(offsets.z));
  if (isFiniteNumber(offsets.a) && offsetInputs.a) offsetInputs.a.value = String(Number(offsets.a));
  if (isFiniteNumber(offsets.c) && offsetInputs.c) offsetInputs.c.value = String(Number(offsets.c));
}

function applyCalibrationHardOffsetsToUi() {
  const xTouch = Number(calibrationCfg?.xTouchMm);
  const yTouch = Number(calibrationCfg?.yTouchMm);
  const zTouch = Number(calibrationCfg?.zTouchMm);

  if (Number.isFinite(xTouch) && offsetInputs.x) offsetInputs.x.value = String(xTouch);
  if (Number.isFinite(yTouch) && offsetInputs.y) offsetInputs.y.value = String(yTouch);
  if (Number.isFinite(zTouch) && offsetInputs.z) offsetInputs.z.value = String(zTouch);
}

function xTouchCCompensationMm(cDegrees) {
  if (meshMounts?.enableXTouchC90Compensation !== true) {
    return 0;
  }

  const xTouch = Number(calibrationCfg?.xTouchMm);
  const xTouchC90 = Number(calibrationCfg?.xTouchC90Mm);
  if (!Number.isFinite(xTouch) || !Number.isFinite(xTouchC90)) {
    return 0;
  }
  const delta = xTouchC90 - xTouch;
  return delta * Math.sin(THREE.MathUtils.degToRad(cDegrees));
}

function parseRotationTriplet(value) {
  if (!Array.isArray(value) || value.length < 3) return null;

  const rx = Number(value[0]);
  const ry = Number(value[1]);
  const rz = Number(value[2]);
  if (!isFiniteNumber(rx) || !isFiniteNumber(ry) || !isFiniteNumber(rz)) return null;
  return { rx, ry, rz };
}

function parseTranslationTriplet(value) {
  if (!Array.isArray(value) || value.length < 3) return null;

  const tx = Number(value[0]);
  const ty = Number(value[1]);
  const tz = Number(value[2]);
  if (!isFiniteNumber(tx) || !isFiniteNumber(ty) || !isFiniteNumber(tz)) return null;
  return { tx, ty, tz };
}

function nodeMeshRotationOverrideFromKinematics(nodeName) {
  if (!legacyMeshOverridesEnabled()) {
    return null;
  }

  const meshRotations = kinematicsInputs?.mesh_rotations_deg_xyz;
  if (meshRotations && typeof meshRotations === "object") {
    const parsed = parseRotationTriplet(meshRotations[nodeName]);
    if (parsed) return parsed;
  }

  const legacyNodeRotations = kinematicsInputs?.node_rotations_deg_xyz;
  if (legacyNodeRotations && typeof legacyNodeRotations === "object") {
    const parsed = parseRotationTriplet(legacyNodeRotations[nodeName]);
    if (parsed) return parsed;
  }

  return null;
}

function nodeMeshTranslationOverrideFromKinematics(nodeName) {
  if (!legacyMeshOverridesEnabled()) {
    return null;
  }

  const meshTranslations = kinematicsInputs?.mesh_translations_mm;
  if (meshTranslations && typeof meshTranslations === "object") {
    const parsed = parseTranslationTriplet(meshTranslations[nodeName]);
    if (parsed) return parsed;
  }

  const legacyNodeTranslations = kinematicsInputs?.node_translations_mm;
  if (legacyNodeTranslations && typeof legacyNodeTranslations === "object") {
    const parsed = parseTranslationTriplet(legacyNodeTranslations[nodeName]);
    if (parsed) return parsed;
  }

  return null;
}

function applyMeshPoseForNode(nodeName) {
  const meshGroup = nodeMeshGroups.get(nodeName);
  if (!meshGroup) return;
  const rot = nodeMeshRotOverrides.get(nodeName) || { rx: 0, ry: 0, rz: 0 };
  const pos = nodeMeshPosOverrides.get(nodeName) || { tx: 0, ty: 0, tz: 0 };
  meshGroup.position.set(pos.tx, pos.ty, pos.tz);
  meshGroup.quaternion.copy(eulerQuaternionFromDegXYZ(rot.rx, rot.ry, rot.rz));
}

async function loadMachineHierarchy() {
  clearMachineTree();
  await loadMeshMounts();
  await loadKinematicsInputs();
  await loadCalibrationInputs();
  await loadBlankInputs();
  await loadToolInputs();
  await loadWheelInputs();
  applyKinematicsInputsToUi();
  applyCalibrationHardOffsetsToUi();
  updateBasisUiFromConfig();
  updateWorldAxisLabels();

  machineBasisQ = machineBasisQuaternionFromUi();
  machineRoot.quaternion.copy(machineBasisQ);

  let machineDef = null;
  try {
    const response = await fetch("/data/machine_definition.json", { cache: "no-store" });
    machineDef = await response.json();
  } catch (error) {
    ui.status.textContent = `Failed to load machine_definition.json: ${error}`;
    return;
  }

  const nodes = machineDef?.nodes || [];
  if (!nodes.length) {
    ui.status.textContent = "machine_definition.json has no nodes.";
    return;
  }

  for (const node of nodes) {
    createNodeObjects(node);
  }

  const firstNode = ui.nodeSelect?.value || nodes[0]?.name;
  if (firstNode && nodeMeshRotOverrides.has(firstNode)) {
    const rot = nodeMeshRotOverrides.get(firstNode);
    setNodeRotationInputs(rot.rx, rot.ry, rot.rz);
  }

  for (const node of nodes) {
    const entry = nodeState.get(node.name);
    const parentName = node.parent;
    if (parentName && nodeState.has(parentName)) {
      nodeState.get(parentName).dynamicGroup.add(entry.staticGroup);
    } else {
      machineRoot.add(entry.staticGroup);
    }
  }

  attachGeometryByNode("base", nodeState.get("base")?.dynamicGroup || machineRoot);
  attachGeometryByNode("x_axis", nodeState.get("x_axis")?.dynamicGroup || machineRoot);
  attachGeometryByNode("y_axis", nodeState.get("y_axis")?.dynamicGroup || machineRoot);
  attachGeometryByNode("z_axis", nodeState.get("z_axis")?.dynamicGroup || machineRoot);
  attachGeometryByNode("c_axis", nodeState.get("c_axis")?.dynamicGroup || machineRoot);
  attachGeometryByNode("a_axis", nodeState.get("a_axis")?.dynamicGroup || machineRoot);
  attachGeometryByNode("spindle", nodeState.get("spindle")?.dynamicGroup || machineRoot);
  attachGeometryByNode("wheel", nodeState.get("wheel")?.dynamicGroup || machineRoot);

  if (meshMounts?.showPivotMarkers === true) {
    const pivotNodes = [
      ["x_axis", 0x2ec4ff, "X pivot"],
      ["y_axis", 0x6de07a, "Y pivot"],
      ["z_axis", 0xa58bff, "Z pivot"],
      ["c_axis", 0xff7f50, "C pivot"],
      ["a_axis", 0x7aa2ff, "A pivot"],
    ];
    for (const [nodeName, color, label] of pivotNodes) {
      const group = nodeState.get(nodeName)?.dynamicGroup;
      if (group) addPivotMarker(group, color, label);
    }
  }

  syncSelectedNodePoseInputs();

  hierarchyReady = true;

  // Debug: log structural positions of all nodes
  try {
    scene.updateMatrixWorld(true);
    const diagLines = [`[viewer] build=${VIEWER_BUILD}`];
    for (const [name, entry] of nodeState) {
      const sp = entry.staticGroup.position;
      const wp = new THREE.Vector3();
      entry.staticGroup.getWorldPosition(wp);
      const line = `${name}: local=(${sp.x.toFixed(1)}, ${sp.y.toFixed(1)}, ${sp.z.toFixed(1)})  world=(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}, ${wp.z.toFixed(1)})`;
      console.warn(`[node] ${line}`);
      diagLines.push(line);
    }
    ui.status.textContent = diagLines.join("\n");
  } catch (diagError) {
    console.error("[viewer] diagnostic error:", diagError);
    ui.status.textContent = `Diagnostic error: ${diagError.message}`;
  }
}

let trail = null;

function rebuildTrail(frames, settings) {
  if (trail) {
    scene.remove(trail);
    trail.geometry.dispose();
    trail.material.dispose();
    trail = null;
  }
  if (!frames.length || !ui.pathToggle.checked) return;

  const pts = frames.map((f) => {
    const p = new THREE.Vector3(
      f.x * settings.signs.x + settings.offsets.x,
      f.y * settings.signs.y + settings.offsets.y,
      f.z * settings.signs.z + settings.offsets.z
    );
    return p.applyQuaternion(machineBasisQ);
  });

  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0xffcc00 });
  trail = new THREE.Line(geo, mat);
  scene.add(trail);
}

function setAxisRotation(group, axisDirection, degrees) {
  group.quaternion.identity();
  const radians = THREE.MathUtils.degToRad(degrees);
  group.quaternion.setFromAxisAngle(axisDirection, radians);
}

function applyFrame(index) {
  if (!state.frames.length || !hierarchyReady) return;

  const frame = state.frames[Math.max(0, Math.min(index, state.frames.length - 1))];
  const settings = collectTransformSettings();

  const xNode = nodeState.get("x_axis")?.dynamicGroup;
  const yNode = nodeState.get("y_axis")?.dynamicGroup;
  const zNode = nodeState.get("z_axis")?.dynamicGroup;
  const aNode = nodeState.get("a_axis")?.dynamicGroup;
  const cNode = nodeState.get("c_axis")?.dynamicGroup;

  const cValue = frame.c * settings.signs.c + settings.offsets.c;
  const xValue = frame.x * settings.signs.x + settings.offsets.x + xTouchCCompensationMm(cValue);
  const yValue = frame.y * settings.signs.y + settings.offsets.y + VIEWER_Y_AXIS_OFFSET_MM;
  if (ui.status && Math.abs(VIEWER_Y_AXIS_OFFSET_MM) > 1e-6) {
    ui.status.textContent += `\n[viewer] Y axis offset=${VIEWER_Y_AXIS_OFFSET_MM.toFixed(1)}mm`;
  }
  const zValue = frame.z * settings.signs.z + settings.offsets.z;

  if (xNode) xNode.position.copy(settings.axisDirections.x.clone().multiplyScalar(xValue));
  if (yNode) yNode.position.copy(settings.axisDirections.y.clone().multiplyScalar(yValue));
  if (zNode) zNode.position.copy(settings.axisDirections.z.clone().multiplyScalar(zValue));

  const aValue = frame.a * settings.signs.a + settings.offsets.a;
  if (aNode) setAxisRotation(aNode, settings.axisDirections.a, aValue);
  if (cNode) setAxisRotation(cNode, settings.axisDirections.c, -cValue);

  updateAxisHud({
    x: frame.x,
    y: frame.y,
    z: frame.z,
    a: frame.a,
    c: frame.c,
    feed: frame.feed,
    motionMode: frame.motionMode,
  });

  ui.frameSlider.value = String(index);
  ui.frameLabel.textContent = `${index + 1} / ${state.frames.length}`;
  ui.status.textContent = [
    `Line: ${frame.line}`,
    frame.raw,
    `X:${frame.x.toFixed(3)}  Y:${frame.y.toFixed(3)}  Z:${frame.z.toFixed(3)}  A:${frame.a.toFixed(3)}  C:${frame.c.toFixed(3)}${Number.isFinite(frame.feed) ? `  F:${frame.feed.toFixed(3)}` : ""}`,
    "",
    "C rotates workhead around wheelhead; wheel center mapping follows X/Y/Z. Adjust signs/offsets/vectors and click Apply.",
  ].join("\n");

  updateSimToFrame(index);
}

function loadFrames(frames) {
  state.frames = frames;
  state.segmentDurations = buildPlaybackSegmentDurations(frames);
  state.frameIndex = 0;
  state.playing = false;
  state.timeAccumulator = 0;

  ui.frameSlider.max = String(Math.max(0, frames.length - 1));
  ui.frameSlider.value = "0";

  const settings = collectTransformSettings();
  rebuildTrail(frames, settings);

  if (frames.length > 0 && hierarchyReady) {
    applyFrame(0);
    ui.status.textContent = `Loaded ${frames.length} motion frames.\n` + ui.status.textContent;
  } else if (frames.length > 0 && !hierarchyReady) {
    ui.status.textContent = `Loaded ${frames.length} motion frames. Waiting for hierarchy load...`;
  } else {
    ui.frameLabel.textContent = "0 / 0";
    ui.status.textContent = "No motion frames found in file.";
    updateAxisHud({ x: 0, y: 0, z: 0, a: 0, c: 0, feed: null, motionMode: null });
  }
}

function initWorkpieceSim() {
  if (!simState.ncText || !state.frames.length) return;

  if (ui.sweepAxisToggle) {
    VIEWER_LOCK_SWEEP_AXIS = ui.sweepAxisToggle.checked;
  }

  const blankDiam = Number(blankCfg.blankDiameterMm || 12);
  const blankLen = Number(blankCfg.blankLengthMm || 100);
  const toolOd = Number(toolCfg.odSizeMm || blankDiam);
  const fluteDepth = Number(toolCfg.flute1DepthMm || 3.2);
  const facetAngle = Number(toolCfg.odRelief1FacetAngleDeg || 12);
  const fluteLen = Number(toolCfg.flute1LengthMm || 50);
  const odReliefLen = Number(toolCfg.odRelief1LengthMm || 12);
  const fluteWheelOd = Number(wheelCfg.wheel2ODMm || 125);
  const fluteWheelCornerR = Number(wheelCfg.wheel2CornerRadiusMm || 0.2);
  const fluteWheelRadius = Math.max(0, fluteWheelOd / 2 - Math.max(0, fluteWheelCornerR));
  const fluteWheelWidthMm = Number(wheelCfg.wheel2WidthMm || 12);
  const odWheelWidthMm = Number(wheelCfg.wheel1ActiveFaceMm || 25);
  const odWheelRadiusMm = Number(wheelCfg.wheel1ODMm || 110) / 2;
  const fluteWheelOffset1 = Number(toolCfg.flute1WheelOffsetAngleDeg || 0);
  const fluteWheelOffset2 = Number(toolCfg.flute2WheelOffsetAngleDeg || 0);

  const sections = parseNcSections(simState.ncText);
  simState.classifiedFrames = classifyFrames(state.frames, sections);
  if (!sections.length) {
    simState.classifiedFrames = state.frames.map((frame) => ({
      ...frame,
      section: "FLUTE 1",
    }));
    if (ui.status) {
      ui.status.textContent += "\n[viewer] No NC sections found; treating all frames as FLUTE 1 for sweep preview.";
    }
  }

  const settings = collectTransformSettings();
  const simDefault = new THREE.Vector3(1, 0, 0);
  const aDir = settings.axisDirections.a.clone().normalize();
  const simToMachineQuat = new THREE.Quaternion().setFromUnitVectors(simDefault, aDir);

  const faceOffset = Number(calibrationCfg.aAxisFaceOffsetMm || 127.55);
  const faceFromAAxisFace = Number(blankCfg.blankLengthFromAAxisFaceMm || 30);
  const tipDist = -faceOffset + faceFromAAxisFace;
  const backEndDist = tipDist - blankLen;
  const aAxisPivot = new THREE.Vector3(0, 0, 0);
  const cAxisPivot = new THREE.Vector3(0, 0, 0);
  const spindleOriginMachine = new THREE.Vector3(0, 0, 0);
  if (hierarchyReady) {
    const invBasis = machineBasisQ.clone().invert();
    const aGroup = nodeState.get("a_axis")?.staticGroup;
    const cGroup = nodeState.get("c_axis")?.staticGroup;
    const spindleGroup = nodeState.get("spindle")?.staticGroup;
    if (aGroup) {
      aGroup.getWorldPosition(aAxisPivot);
      aAxisPivot.applyQuaternion(invBasis);
    }
    if (cGroup) {
      cGroup.getWorldPosition(cAxisPivot);
      cAxisPivot.applyQuaternion(invBasis);
    }
    if (spindleGroup) {
      const spindleWorldPos = new THREE.Vector3();
      const spindleWorldQuat = new THREE.Quaternion();
      spindleGroup.getWorldPosition(spindleWorldPos);
      spindleGroup.getWorldQuaternion(spindleWorldQuat);
      const spMeshPos = nodeMeshPosOverrides.get("spindle") || { tx: 0, ty: 0, tz: 0 };
      const flangeNudgeMm = 19;
      const localOffset = new THREE.Vector3(spMeshPos.tx, spMeshPos.ty + flangeNudgeMm, spMeshPos.tz);
      const offsetWorld = localOffset.applyQuaternion(spindleWorldQuat);
      const offsetMachine = offsetWorld.applyQuaternion(invBasis);

      spindleOriginMachine.copy(spindleWorldPos.applyQuaternion(invBasis)).add(offsetMachine);
    }
  }

  const barRadius = Number(calibrationCfg.aAxisBarDiameterMm || 40) / 2;
  const diskRadius = Number(calibrationCfg.spindleDiskDiameterMm || 150.16) / 2;
  const diskLen = Number(calibrationCfg.spindleDiskLengthFromSpindleMountMm || 0);
  const yTouch = Number(calibrationCfg.yTouchMm || 0);
  const zTouch = Number(calibrationCfg.zTouchMm || 0);
  if (Number.isFinite(yTouch) && Number.isFinite(zTouch)) {
    const ty = barRadius + diskLen - yTouch;
    const tz = aAxisPivot.z + barRadius + diskRadius - zTouch;
    spindleOriginMachine.set(
      spindleOriginMachine.x,
      aAxisPivot.y + ty,
      tz
    );
  }
  // Sim origin is the blank back-end point in MACHINE coordinates.
  // aAxisPivot is the machine-frame location of the A-axis node origin;
  // omitting it leaves wheel centers translated far from the blank.
  const simToMachinePos = aAxisPivot.clone().add(aDir.clone().multiplyScalar(backEndDist));

  simState.sim = new WorkpieceSim({
    blankRadius: blankDiam / 2,
    blankLength: blankLen,
    toolRadius: toolOd / 2,
    fluteDepthMm: fluteDepth,
    facetAngleDeg: facetAngle,
    fluteLength: fluteLen,
    odReliefLength: odReliefLen,
    fluteWheelRadius: fluteWheelRadius,
    fluteWheelWidthMm: fluteWheelWidthMm,
    odWheelWidthMm: odWheelWidthMm,
    wheel1RadiusMm: odWheelRadiusMm,
    wheel1WidthMm: odWheelWidthMm,
    wheel2RadiusMm: fluteWheelRadius,
    wheel2WidthMm: fluteWheelWidthMm,
    axisDirections: settings.axisDirections,
    axisOffsets: settings.offsets,
    axisSigns: settings.signs,
    spindleAxisDir: configuredSpindleAxisDirection(),
    spindleOriginMachine,
    simToMachineQuat,
    simToMachinePos,
    aAxisPivot,
    cAxisPivot,
    useWheelheadYZOnly: false,
    wheel1GrindSide: wheelCfg.wheel1GrindSide,
    wheel2GrindSide: wheelCfg.wheel2GrindSide,
    wheel1YOffsetMm: Number(wheelCfg.wheel1YOffsetMm || 0),
    wheel2YOffsetMm: Number(wheelCfg.wheel2YOffsetMm || 0),
    flute1WheelOffsetAngleDeg: fluteWheelOffset1,
    flute2WheelOffsetAngleDeg: fluteWheelOffset2,
    enableVoxelCut: VIEWER_SHOW_VOXELS,
    lockSweepAxis: VIEWER_LOCK_SWEEP_AXIS,
    sweepCenterOffset: VIEWER_SWEEP_CENTER_OFFSET,
    useNcFrame: VIEWER_USE_NC_FRAME,
  });

  // Process up to current frame
  simState.sim.processUpToFrame(
    simState.classifiedFrames,
    state.frameIndex
  );

  // Build mesh and attach to a_axis
  const aAxisDyn = nodeState.get("a_axis")?.dynamicGroup;
  if (aAxisDyn) {
    // Remove previous sim mesh if any
    if (simState.mesh && simState.mesh.parent) {
      simState.mesh.parent.remove(simState.mesh);
      simState.mesh.geometry.dispose();
      simState.mesh.material.dispose();
    }
    simState.mesh = simState.sim.buildMesh();
    simState.mesh.name = "workpiece_sim";
    // Sim mesh axis is +X — rotate to match A-axis direction in local frame
    const simDefault = new THREE.Vector3(1, 0, 0);
    const aDir = settings.axisDirections.a.clone().normalize();
    simState.mesh.quaternion.setFromUnitVectors(simDefault, aDir);

    // Position sim mesh: face is at -faceOffset along barDir, blank sticks toward +barDir
    const yNudge = configuredSpindleAxisDirection().multiplyScalar(VIEWER_BLANK_Y_NUDGE_MM);
    simState.mesh.position.copy(aDir.clone().multiplyScalar(backEndDist)).add(yNudge);
    console.warn(`[sim] positioned: faceOffset=${faceOffset} faceOff=${faceFromAAxisFace} tipDist=${tipDist} backEnd=${backEndDist} yNudge=${VIEWER_BLANK_Y_NUDGE_MM}`);

    aAxisDyn.add(simState.mesh);

    if (simState.sweepGroup && simState.sweepGroup.parent) {
      simState.sweepGroup.parent.remove(simState.sweepGroup);
    }
    simState.sweepGroup = new THREE.Group();
    simState.sweepGroup.name = "sweep_wireframe";
    if (VIEWER_SWEEP_IN_MACHINE) {
      machineRoot.add(simState.sweepGroup);
    } else {
      simState.mesh.add(simState.sweepGroup);
    }

    // Hide the original simple blank cylinder
    const blank = aAxisDyn.getObjectByName("workpiece_blank");
    if (blank) blank.visible = false;
  }

  console.warn(
    `[sim] Workpiece sim initialised: ${simState.classifiedFrames.length} classified frames, ` +
      `${sections.length} sections`
  );
}

function updateSimToFrame(frameIndex) {
  if (!simState.sim || !simState.classifiedFrames.length) return;
  simState.sim.processUpToFrame(simState.classifiedFrames, frameIndex);
  if (simState.mesh && VIEWER_SHOW_VOXELS) {
    simState.sim.buildMesh(simState.mesh);
  }

  updateSweepWireframe();

  const debug = simState.sim.getLastDebug?.();
  if (debug && ui.status) {
    const center = debug.centerSim || new THREE.Vector3();
    const axis = debug.axisSim || new THREE.Vector3(0, 1, 0);
    const mCenter = debug.centerMachine;
    const mAxis = debug.axisMachine;
    ui.status.textContent += [
      "",
      `[sim] op=${debug.op} section=${debug.section || "-"} line=${debug.line}`,
      `[sim] wheelR=${debug.wheelRadius.toFixed(2)} halfW=${debug.wheelHalfWidth.toFixed(2)} centerOff=${debug.wheelCenterOffset.toFixed(2)} axisDist=${debug.axisDist.toFixed(2)} tAxis=${debug.tAxis.toFixed(2)} tAxisRaw=${debug.tAxisRaw?.toFixed(2) ?? "-"} centerAdj=${debug.centerAdjust.toFixed(2)} inRange=${debug.axialInRange} hit=${debug.intersects}`,
      `[sim] centerSim=(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}) axisSim=(${axis.x.toFixed(3)}, ${axis.y.toFixed(3)}, ${axis.z.toFixed(3)}) a=${debug.aDeg.toFixed(2)} c=${debug.cDeg.toFixed(2)}`,
      mCenter && mAxis
        ? `[sim] centerMachine=(${mCenter.x.toFixed(2)}, ${mCenter.y.toFixed(2)}, ${mCenter.z.toFixed(2)}) axisMachine=(${mAxis.x.toFixed(3)}, ${mAxis.y.toFixed(3)}, ${mAxis.z.toFixed(3)})`
        : "[sim] centerMachine=(n/a) axisMachine=(n/a)",
    ].join("\n");
  }

  const stats = simState.sim.getLastStats?.();
  if (stats && ui.status) {
    ui.status.textContent += `\n[sim] changedCells=${stats.changedCells} minRadius=${stats.minRadius.toFixed(3)}`;
  }
}

function clearSweepWireframe() {
  if (!simState.sweepGroup) return;
  while (simState.sweepGroup.children.length > 0) {
    const child = simState.sweepGroup.children.pop();
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
}

function updateSweepWireframe() {
  if (!simState.sweepGroup) return;
  if (!ui.sweepToggle || !ui.sweepToggle.checked) {
    simState.sweepGroup.visible = false;
    return;
  }

  simState.sweepGroup.visible = true;
  clearSweepWireframe();

  const samples = simState.sim?.getSweepSamples?.() || [];
  if (!samples.length) return;

  const baseAxis = new THREE.Vector3(0, 1, 0);
  const mat = new THREE.MeshBasicMaterial({ color: 0x55ffaa, wireframe: true });

  for (const sample of samples) {
    const height = Math.max(0.01, sample.halfWidth * 2);
    const geo = new THREE.CylinderGeometry(sample.radius, sample.radius, height, 12, 1, true);
    const mesh = new THREE.Mesh(geo, mat);
    const axis = VIEWER_LOCK_SWEEP_AXIS
      ? new THREE.Vector3(0, 1, 0)
      : (VIEWER_SWEEP_IN_MACHINE ? (sample.axisMachine || sample.axis) : (sample.axisRaw || sample.axis));
    const center = VIEWER_SWEEP_IN_MACHINE
      ? (sample.centerMachine || sample.center)
      : sample.center;
    mesh.position.copy(center);
    mesh.quaternion.setFromUnitVectors(baseAxis, axis);
    simState.sweepGroup.add(mesh);
  }
}

function runSimBenchmark() {
  if (!simState.ncText || !state.frames.length) {
    if (ui.simBenchOut) ui.simBenchOut.textContent = "Load an NC file first.";
    return;
  }

  if (!simState.classifiedFrames.length) {
    const sections = parseNcSections(simState.ncText);
    simState.classifiedFrames = classifyFrames(state.frames, sections);
  }

  const blankDiam = Number(blankCfg.blankDiameterMm || 12);
  const blankLen = Number(blankCfg.blankLengthMm || 100);
  const toolOd = Number(toolCfg.odSizeMm || blankDiam);
  const fluteDepth = Number(toolCfg.flute1DepthMm || 3.2);
  const facetAngle = Number(toolCfg.odRelief1FacetAngleDeg || 12);
  const fluteLen = Number(toolCfg.flute1LengthMm || 50);
  const odReliefLen = Number(toolCfg.odRelief1LengthMm || 12);
  const fluteWheelOd = Number(wheelCfg.wheel2ODMm || 125);
  const fluteWheelCornerR = Number(wheelCfg.wheel2CornerRadiusMm || 0.2);
  const fluteWheelRadius = Math.max(0, fluteWheelOd / 2 - Math.max(0, fluteWheelCornerR));
  const fluteWheelWidthMm = Number(wheelCfg.wheel2WidthMm || 12);
  const odWheelWidthMm = Number(wheelCfg.wheel1ActiveFaceMm || 25);

  const baseCfg = {
    blankRadius: blankDiam / 2,
    blankLength: blankLen,
    toolRadius: toolOd / 2,
    fluteDepthMm: fluteDepth,
    facetAngleDeg: facetAngle,
    fluteLength: fluteLen,
    odReliefLength: odReliefLen,
    fluteWheelRadius: fluteWheelRadius,
    fluteWheelWidthMm: fluteWheelWidthMm,
    odWheelWidthMm: odWheelWidthMm,
    captureSweepEvery: 99999,
    maxSweepSamples: 0,
  };

  const sizes = [
    { nz: 200, ntheta: 360 },
    { nz: 300, ntheta: 540 },
    { nz: 400, ntheta: 720 },
    { nz: 600, ntheta: 1080 },
    { nz: 800, ntheta: 1440 },
  ];

  const lines = ["Sim benchmark (process + mesh build):"]; 
  for (const s of sizes) {
    const sim = new WorkpieceSim({ ...baseCfg, nz: s.nz, ntheta: s.ntheta });
    const t0 = performance.now();
    sim.processUpToFrame(simState.classifiedFrames, state.frameIndex);
    sim.buildGeometry();
    const t1 = performance.now();
    lines.push(`${s.nz}x${s.ntheta}: ${(t1 - t0).toFixed(1)} ms`);
  }

  if (ui.simBenchOut) ui.simBenchOut.textContent = lines.join("\n");
}

ui.ncFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  state.currentNcPath = null;
  state.currentNcLabel = file.name;
  watchState.ncStamp = null;
  window.localStorage.removeItem(LAST_NC_SELECTION_KEY);
  if (ui.ncSelect) ui.ncSelect.value = "";
  const text = await file.text();
  simState.ncText = text;
  const frames = parseNc(text);
  loadFrames(frames);

  // Re-read configs so depth / geometry changes take effect without
  // a full page reload.
  await loadBlankInputs();
  await loadToolInputs();
  await loadWheelInputs();

  initWorkpieceSim();
});

if (ui.ncSelect) {
  ui.ncSelect.addEventListener("change", async () => {
    const fileName = ui.ncSelect.value;
    if (!fileName) return;
    window.localStorage.setItem(LAST_NC_SELECTION_KEY, fileName);
    if (ui.ncFile) ui.ncFile.value = "";
    const encodedName = encodeURIComponent(fileName);
    await loadNcFromPath(`/nc_output/${encodedName}`, fileName);
  });
}

if (ui.simBenchBtn) {
  ui.simBenchBtn.addEventListener("click", runSimBenchmark);
}

ui.playBtn.addEventListener("click", () => {
  if (state.frames.length > 0) {
    if (state.frameIndex >= state.frames.length - 1) {
      state.frameIndex = 0;
      applyFrame(0);
    }
    state.timeAccumulator = 0;
    state.playing = true;
  }
});

ui.pauseBtn.addEventListener("click", () => {
  state.playing = false;
});

ui.resetBtn.addEventListener("click", () => {
  state.playing = false;
  state.frameIndex = 0;
  state.timeAccumulator = 0;
  applyFrame(0);
});

if (ui.homeBtn) {
  ui.homeBtn.addEventListener("click", () => {
    setHomeView();
  });
}

ui.frameSlider.addEventListener("input", () => {
  state.playing = false;
  state.timeAccumulator = 0;
  state.frameIndex = Number.parseInt(ui.frameSlider.value, 10) || 0;
  applyFrame(state.frameIndex);
});

if (ui.sweepAxisToggle) {
  ui.sweepAxisToggle.addEventListener("change", () => {
    VIEWER_LOCK_SWEEP_AXIS = ui.sweepAxisToggle.checked;
    if (simState.sim) {
      simState.sim.lockSweepAxis = VIEWER_LOCK_SWEEP_AXIS;
      simState.sim.processUpToFrame(simState.classifiedFrames, state.frameIndex);
      updateSweepWireframe();
    }
    if (ui.status) {
      ui.status.textContent += `\n[viewer] Lock Sweep Axis=${VIEWER_LOCK_SWEEP_AXIS}`;
    }
  });
}

if (ui.sweepToggle) {
  ui.sweepToggle.addEventListener("change", () => {
    updateSweepWireframe();
  });
}

const SPEED_STEPS = [0.15, 0.25, 0.5, 0.75, 1.0, 2.0];

function syncSpeedFromSlider() {
  const raw = Number.parseInt(ui.speedSlider.value, 10);
  const idx = Number.isNaN(raw) ? 4 : raw;
  state.speed = SPEED_STEPS[idx] ?? 1.0;
  ui.speed.value = state.speed.toFixed(2);
  ui.speedLabel.textContent = (state.speed < 1 ? '.' + String(state.speed).split('.')[1] : String(state.speed)) + 'x';
}

ui.speedSlider.addEventListener("input", syncSpeedFromSlider);

ui.speed.addEventListener("change", () => {
  const speed = numberInputValue(ui.speed, 1.0);
  state.speed = Math.max(0.1, speed);
  ui.speed.value = state.speed.toFixed(1);
});

// Startup flow: populate nc_output picker, load machine hierarchy,
// then auto-load last selected NC (if any).
async function bootstrapViewer() {
  await refreshNcFileList();
  await loadMachineHierarchy();
  startDiskWatchLoop();

  if (ui.ncSelect && ui.ncSelect.value) {
    const fileName = ui.ncSelect.value;
    const encodedName = encodeURIComponent(fileName);
    await loadNcFromPath(`/nc_output/${encodedName}`, fileName);
  }
}

ui.applyBtn.addEventListener("click", () => {
  if (!state.frames.length || !hierarchyReady) return;
  const settings = collectTransformSettings();
  updateWorldAxisLabels();
  rebuildTrail(state.frames, settings);
  applyFrame(state.frameIndex);
});

ui.saveKinematicsBtn?.addEventListener("click", async () => {
  try {
    await saveKinematicsInputs();
  } catch (error) {
    ui.status.textContent = `Save failed: ${error}. Start tools/nc_orientation_viewer/dev_server.js and retry.`;
  }
});

ui.pathToggle.addEventListener("change", () => {
  if (!state.frames.length) return;
  rebuildTrail(state.frames, collectTransformSettings());
});

linkRotationInputPair(ui.nodeRx, ui.nodeRxSlider);
linkRotationInputPair(ui.nodeRy, ui.nodeRySlider);
linkRotationInputPair(ui.nodeRz, ui.nodeRzSlider);

const liveNodeRotationApply = () => {
  applyNodeRotation();
};

ui.nodeRx?.addEventListener("change", liveNodeRotationApply);
ui.nodeRy?.addEventListener("change", liveNodeRotationApply);
ui.nodeRz?.addEventListener("change", liveNodeRotationApply);
ui.nodeRxSlider?.addEventListener("input", liveNodeRotationApply);
ui.nodeRySlider?.addEventListener("input", liveNodeRotationApply);
ui.nodeRzSlider?.addEventListener("input", liveNodeRotationApply);
ui.nodeTx?.addEventListener("change", liveNodeRotationApply);
ui.nodeTy?.addEventListener("change", liveNodeRotationApply);
ui.nodeTz?.addEventListener("change", liveNodeRotationApply);

ui.applyBasisBtn?.addEventListener("click", () => {
  applyBasisRotation();
});

ui.applyNodeRotBtn?.addEventListener("click", () => {
  applyNodeRotation();
});

ui.nodeSelect?.addEventListener("change", () => {
  syncSelectedNodePoseInputs();
});

window.addEventListener("resize", () => {
  resizeViewport();
});

let previousTs = performance.now();
function animate(ts) {
  const dt = Math.max(0, (ts - previousTs) / 1000);
  previousTs = ts;

  if (state.playing && state.frames.length > 1) {
    state.timeAccumulator += dt * state.speed;
    while (state.frameIndex < state.frames.length - 1) {
      const nextDuration = state.segmentDurations[state.frameIndex + 1] ?? DEFAULT_PLAYBACK_FRAME_TIME_SEC;
      const stepDuration = Math.max(1e-4, nextDuration);
      if (state.timeAccumulator < stepDuration) break;

      state.timeAccumulator -= stepDuration;
      state.frameIndex += 1;
      if (state.frameIndex >= state.frames.length) {
        state.frameIndex = state.frames.length - 1;
        state.playing = false;
        state.timeAccumulator = 0;
        break;
      }
      applyFrame(state.frameIndex);
    }

    if (state.frameIndex >= state.frames.length - 1) {
      state.playing = false;
      state.timeAccumulator = 0;
    }
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
bootstrapViewer();
