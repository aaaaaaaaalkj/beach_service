// UI, serve flow, cameras and save slots.
import * as THREE from 'three';
import { COURT_LENGTH, COURT_WIDTH, POLE_DISTANCE, CONTACT_HEIGHT_MEN, CONTACT_HEIGHT_WOMEN } from './constants.js';
import {
    createServe, servePosition, launchDirection, netHeightFor, windVelocityFrom, difficultyScore, DEFAULT_AERO,
    floatContact,
} from './physics.js';
import { createBeachScene } from './scene.js';

const NUM_SAVE_SLOTS = 5;
const MAX_FRAME_DELTA = 0.1; // s, cap per rendered frame to avoid a spiral of death

// Ball cam
const BALL_CAM_END_DELAY = 1000; // ms to stay in ball cam after landing
const BALL_CAM_TRANSITION_SPEED = 0.07; // Lerp factor per 1/60 s
const BALL_CAM_FOLLOW_SPEED = 0.1;      // Lerp factor per 1/60 s
const BALL_CAM_BEHIND = 0.6;    // m behind the ball
const BALL_CAM_ABOVE = 0.2;     // m above the ball
const BALL_CAM_LOOK_AHEAD = 5.0; // m ahead along the flight direction

// A serve goes through these phases; the ball cam ones are skipped without ball cam
const Phase = {
    IDLE: 'idle',
    CAM_IN: 'camIn',     // Camera flies to the ball
    FLYING: 'flying',    // Physics running
    CAM_HOLD: 'camHold', // Ball landed, ball cam holds the view for a moment
    CAM_OUT: 'camOut',   // Camera flies back
};

// --- DOM ---
const $ = id => document.getElementById(id);
const container = $('container');
const controlsDiv = $('controls');
const toggleControlsButton = $('toggleControlsButton');
const serveButton = $('serveButton');
const quickServeButton = $('quickServeButton');
const windControlsDiv = $('windControls');
const saveLoadDiv = $('saveLoad');
const saveStatus = $('saveStatus');
const results = {
    classification: $('resultClassification'),
    speedLabel: $('resultSpeedLabel'),
    speed: $('resultFinalSpeed'),
    time: $('resultFlightTime'),
    difficulty: $('resultDifficulty'),
};
const settingsFieldsets = ['basicsFieldset', 'launchFieldset', 'environmentFieldset', 'saveLoadFieldset'].map($);
const cameraFieldset = $('cameraFieldset');
const enableBallCamCheckbox = $('enableBallCam');

// Inputs backing the settings object: key => [element, type]
const inputs = {
    launchPosition: [$('launchPosition'), 'text'],
    contactHeight: [$('contactHeight'), 'number'],
    launchSpeed: [$('launchSpeed'), 'number'],
    verticalAngle: [$('verticalAngle'), 'number'],
    horizontalAngle: [$('horizontalAngle'), 'number'],
    spin: [$('spin'), 'number'],
    floatSeed: [$('floatSeed'), 'number'],
    autoReroll: [$('autoReroll'), 'checkbox'],
    windEnabled: [$('enableWind'), 'checkbox'],
    windStrength: [$('windStrength'), 'number'],
    windDirection: [$('windDirection'), 'number'],
    dragCrisis: [$('dragCrisis'), 'checkbox'],
    criticalSpeed: [$('criticalSpeed'), 'number'],
    knuckleStrength: [$('knuckleStrength'), 'number'],
    ballCam: [enableBallCamCheckbox, 'checkbox'],
};
const genderMaleRadio = $('genderMale');
const genderFemaleRadio = $('genderFemale');

// --- State ---
const view = createBeachScene(container);
const { camera, controls } = view;
const clock = new THREE.Clock();

let phase = Phase.IDLE;
let serveUsesBallCam = false;
let serve = null; // ServeSimulation of the current/last serve
let trajectoryPoints = [];
let ballCamEndTime = 0;
const preBallCamPosition = new THREE.Vector3();
const preBallCamTarget = new THREE.Vector3();
const ballCamStartPosition = new THREE.Vector3();
const ballCamStartLookAt = new THREE.Vector3();

// --- Settings ---

function readSettings() {
    const settings = { gender: genderFemaleRadio.checked ? 'female' : 'male' };
    for (const [key, [el, type]] of Object.entries(inputs)) {
        settings[key] = type === 'checkbox' ? el.checked : type === 'number' ? parseFloat(el.value) : el.value;
    }
    return settings;
}

// Applies a (possibly partial or old) settings object to the inputs; missing values keep their defaults
function applySettings(settings) {
    if (settings.gender === 'female') genderFemaleRadio.checked = true;
    else genderMaleRadio.checked = true;
    for (const [key, [el, type]] of Object.entries(inputs)) {
        const value = settings[key];
        if (value === undefined || value === null) continue;
        if (type === 'checkbox') el.checked = Boolean(value);
        else el.value = value;
    }
    if (inputs.launchPosition[0].value === '') inputs.launchPosition[0].value = 'center';
}

function updateValueDisplays() {
    const s = readSettings();
    $('contactHeightValue').textContent = `${s.contactHeight.toFixed(2)} m`;
    $('launchSpeedValue').textContent = `${s.launchSpeed.toFixed(1)} m/s`;
    $('verticalAngleValue').textContent = `${s.verticalAngle} °`;
    $('horizontalAngleValue').textContent = `${s.horizontalAngle} °`;
    const spinType = s.spin > 0 ? 'topspin' : s.spin < 0 ? 'backspin' : 'float';
    $('spinValue').textContent = `${Math.abs(s.spin).toFixed(1)} rev/s (${spinType})`;
    $('windStrengthValue').textContent = `${s.windStrength.toFixed(1)} m/s`;
    $('windDirectionValue').textContent = `${s.windDirection} °`;
    $('floatSeedValue').textContent = `#${s.floatSeed}`;
    $('criticalSpeedValue').textContent = `${s.criticalSpeed.toFixed(1)} m/s`;
    $('knuckleStrengthValue').textContent = s.knuckleStrength.toFixed(2);
    windControlsDiv.classList.toggle('hidden', !s.windEnabled);
    $('dragCrisisControls').classList.toggle('hidden', !s.dragCrisis);
}

// --- UI state ---

const isBusy = () => phase !== Phase.IDLE;
const isBallCamActive = () => serveUsesBallCam && isBusy();

// Single place that enables/disables controls depending on the phase
function updateUIState() {
    const busy = isBusy();
    serveButton.disabled = busy;
    quickServeButton.disabled = busy;
    serveButton.textContent = {
        [Phase.IDLE]: 'Serve!',
        [Phase.CAM_IN]: 'Positioning Cam...',
        [Phase.FLYING]: 'Simulating...',
        [Phase.CAM_HOLD]: 'Returning Camera...',
        [Phase.CAM_OUT]: 'Returning Camera...',
    }[phase];

    // Settings are locked for the whole serve so they can't change mid-flight
    settingsFieldsets.forEach(fs => { fs.disabled = busy; });
    // Camera presets stay usable during a normal flight, but not while the ball cam owns the camera
    cameraFieldset.disabled = isBallCamActive();
    enableBallCamCheckbox.disabled = busy;
}

function showResults(result) {
    results.classification.textContent = result ? result.classification : '-';
    results.classification.className = 'val' + (result ? (result.classification === 'In' ? ' in' : ' fault') : '');
    results.speedLabel.textContent = `${result ? result.speedLabel : 'Landing Speed'}:`;
    results.speed.textContent = result ? `${result.speed.toFixed(1)} m/s` : '- m/s';
    results.time.textContent = result ? `${result.time.toFixed(2)} s` : '- s';
    results.difficulty.textContent = `${result ? difficultyScore(result) : '-'} / 100`;
}

// Puts ball, net, wind and arrow into the pre-serve state for the current settings
function resetToSettings() {
    const s = readSettings();
    const start = servePosition(s.launchPosition, s.contactHeight);
    view.setNetHeight(netHeightFor(s.gender));
    view.setWind(windVelocityFrom(s.windEnabled, s.windStrength, s.windDirection));
    view.setBall(start, floatContact(s.floatSeed).orientation); // Shows how the panels face the hitter
    view.showServeArrow(start, launchDirection(s.verticalAngle, s.horizontalAngle), s.launchSpeed);
    view.clearTrajectory();
    trajectoryPoints = [];
    serve = null;
    showResults(null);
}

function handleSettingsChange() {
    if (isBusy()) return; // Inputs are locked during a serve
    updateValueDisplays();
    resetToSettings();
}

// New ball contact: panel orientation and leftover spin for the knuckle effect
function rerollFloatSeed() {
    inputs.floatSeed[0].value = 1 + Math.floor(Math.random() * 9999);
    updateValueDisplays();
}

// Gender sets the net height and the default contact height
function handleGenderChange() {
    inputs.contactHeight[0].value = genderMaleRadio.checked ? CONTACT_HEIGHT_MEN : CONTACT_HEIGHT_WOMEN;
    handleSettingsChange();
}

// --- Serve flow ---

function startServe() {
    if (isBusy()) return;
    if (readSettings().autoReroll) rerollFloatSeed();
    resetToSettings();
    const settings = readSettings();
    view.hideServeArrow();
    serveUsesBallCam = settings.ballCam;

    if (serveUsesBallCam) {
        preBallCamPosition.copy(camera.position);
        preBallCamTarget.copy(controls.target);
        controls.enabled = false;

        // Camera starts slightly behind and above the ball, looking along the initial path
        const start = servePosition(settings.launchPosition, settings.contactHeight);
        const direction = launchDirection(settings.verticalAngle, settings.horizontalAngle);
        ballCamStartPosition.copy(start).addScaledVector(direction, -BALL_CAM_BEHIND);
        ballCamStartPosition.y += BALL_CAM_ABOVE;
        ballCamStartLookAt.copy(start).addScaledVector(direction, BALL_CAM_LOOK_AHEAD);
        phase = Phase.CAM_IN; // Physics starts once the camera arrives
    } else {
        startFlight();
    }
    updateUIState();
}

function startFlight() {
    serve = createServe(readSettings());
    trajectoryPoints = [serve.position.clone()];
    phase = Phase.FLYING;
    updateUIState();
}

function endFlight() {
    trajectoryPoints.push(serve.position.clone());
    view.setTrajectory(trajectoryPoints);
    showResults(serve.result);

    if (serveUsesBallCam) {
        ballCamEndTime = performance.now();
        phase = Phase.CAM_HOLD;
    } else {
        phase = Phase.IDLE;
        showIdleArrow();
    }
    updateUIState();
}

function showIdleArrow() {
    const s = readSettings();
    view.showServeArrow(servePosition(s.launchPosition, s.contactHeight), launchDirection(s.verticalAngle, s.horizontalAngle), s.launchSpeed);
}

// --- Cameras ---

// Frame-rate independent lerp factor (factor is defined per 1/60 s)
const frameLerp = (factor, deltaTime) => 1 - Math.pow(1 - factor, deltaTime * 60);

function setCameraPosition(preset) {
    if (isBallCamActive()) return;
    const s = readSettings();
    const netHeight = netHeightFor(s.gender);
    controls.enabled = true;

    switch (preset) {
        case 'baselineSide':
            camera.position.set(COURT_LENGTH * 0.55, 5, POLE_DISTANCE * 0.8);
            controls.target.set(0, netHeight * 0.5, 0);
            break;
        case 'courtSide':
            camera.position.set(0, netHeight * 1.5, COURT_WIDTH * 1.8);
            controls.target.set(0, netHeight * 0.6, 0);
            break;
        case 'top':
            camera.position.set(0, COURT_LENGTH * 1.1, 0.1);
            controls.target.set(0, 0, 0);
            break;
        case 'behind':
        default: {
            // Behind the server, panned slightly with the server's Z position
            const start = servePosition(s.launchPosition, s.contactHeight);
            camera.position.copy(start).add(new THREE.Vector3(-4.5, 2.8, start.z * 0.6));
            controls.target.set(COURT_LENGTH * 0.1, netHeight * 0.5, start.z * 0.4);
            break;
        }
    }
    controls.update();
}

function followBall(deltaTime) {
    if (serve.velocity.lengthSq() < 0.01) return;
    const direction = serve.velocity.clone().normalize();
    const desired = serve.position.clone().addScaledVector(direction, -BALL_CAM_BEHIND);
    desired.y += BALL_CAM_ABOVE;
    camera.position.lerp(desired, frameLerp(BALL_CAM_FOLLOW_SPEED, deltaTime));
    camera.lookAt(serve.position.clone().addScaledVector(direction, BALL_CAM_LOOK_AHEAD));
}

// --- Save/Load ---

const slotKey = slot => `vbServeSim_slot_${slot}`;

// Returns { settings, camera } or null. Older versions stored the settings at the top level.
function readSlot(slot) {
    try {
        const raw = localStorage.getItem(slotKey(slot));
        if (!raw) return null;
        const data = JSON.parse(raw);
        const settings = data.settings ?? { ...data, ballCam: data.ballCamEnabledPref };
        return { settings, camera: data.camera };
    } catch (e) {
        return null;
    }
}

function showSaveStatus(message, isError = false) {
    saveStatus.textContent = message;
    saveStatus.classList.toggle('error', isError);
    clearTimeout(showSaveStatus.timer);
    showSaveStatus.timer = setTimeout(() => { saveStatus.textContent = ''; }, 2500);
}

function slotSummary(settings) {
    const speed = parseFloat(settings.launchSpeed);
    if (!Number.isFinite(speed)) return 'saved';
    return `${speed.toFixed(1)} m/s · ${settings.verticalAngle}° · ${settings.gender === 'female' ? 'W' : 'M'}`;
}

function generateSaveLoadButtons() {
    saveLoadDiv.innerHTML = '';
    for (let i = 1; i <= NUM_SAVE_SLOTS; i++) {
        const slot = readSlot(i);

        const label = document.createElement('span');
        label.className = 'slot-label';
        label.textContent = `${i}`;

        const summary = document.createElement('span');
        summary.className = 'slot-summary' + (slot ? '' : ' empty');
        summary.textContent = slot ? slotSummary(slot.settings) : 'empty';

        const saveButton = document.createElement('button');
        saveButton.textContent = 'Save';
        saveButton.title = `Save settings to slot ${i}`;
        saveButton.addEventListener('click', () => saveSlot(i));

        const loadButton = document.createElement('button');
        loadButton.textContent = 'Load';
        loadButton.title = `Load settings from slot ${i}`;
        loadButton.disabled = !slot;
        loadButton.addEventListener('click', () => loadSlot(i));

        saveLoadDiv.append(label, summary, saveButton, loadButton);
    }
}

function saveSlot(slot) {
    if (isBusy()) return;
    const data = {
        version: 3,
        settings: readSettings(), // windStrength in m/s since version 2
        camera: { position: camera.position.toArray(), target: controls.target.toArray() },
    };
    try {
        localStorage.setItem(slotKey(slot), JSON.stringify(data));
        showSaveStatus(`Saved to slot ${slot}.`);
    } catch (e) {
        console.error(`Could not save settings to slot ${slot}:`, e);
        showSaveStatus('Could not save: browser storage is full or disabled.', true);
    }
    generateSaveLoadButtons();
}

function loadSlot(slot) {
    if (isBusy()) return;
    const data = readSlot(slot);
    if (!data) {
        showSaveStatus(`Slot ${slot} is empty or unreadable.`, true);
        return;
    }
    // Old saves without a contact height use the gender default
    const settings = { ...data.settings };
    settings.contactHeight ??= settings.gender === 'female' ? CONTACT_HEIGHT_WOMEN : CONTACT_HEIGHT_MEN;
    for (const [key, value] of Object.entries(DEFAULT_AERO)) settings[key] ??= value;
    settings.floatSeed ??= 1;
    applySettings(settings);
    handleSettingsChange();

    if (data.camera?.position && data.camera?.target) {
        camera.position.fromArray(data.camera.position);
        controls.target.fromArray(data.camera.target);
        controls.update();
    } else {
        setCameraPosition('behind');
    }
    showSaveStatus(`Loaded slot ${slot}.`);
}

// --- Event wiring ---

function setupUIListeners() {
    genderMaleRadio.addEventListener('change', handleGenderChange);
    genderFemaleRadio.addEventListener('change', handleGenderChange);
    for (const [key, [el, type]] of Object.entries(inputs)) {
        if (key === 'ballCam' || key === 'autoReroll') continue; // Only affect the next serve
        el.addEventListener(type === 'number' ? 'input' : 'change', handleSettingsChange);
    }

    $('rerollSeed').addEventListener('click', () => {
        rerollFloatSeed();
        handleSettingsChange();
    });

    serveButton.addEventListener('click', startServe);
    quickServeButton.addEventListener('click', startServe);

    $('camBehind').addEventListener('click', () => setCameraPosition('behind'));
    $('camBaselineSide').addEventListener('click', () => setCameraPosition('baselineSide'));
    $('camCourtSide').addEventListener('click', () => setCameraPosition('courtSide'));
    $('camTop').addEventListener('click', () => setCameraPosition('top'));

    toggleControlsButton.addEventListener('click', () => {
        const isCollapsed = controlsDiv.classList.toggle('collapsed');
        toggleControlsButton.setAttribute('aria-expanded', String(!isCollapsed));
    });
    window.addEventListener('resize', collapseOnSmallScreens);
}

// Collapse the controls panel on small screens
function collapseOnSmallScreens() {
    if (window.innerWidth < 768 && !controlsDiv.classList.contains('collapsed')) {
        controlsDiv.classList.add('collapsed');
        toggleControlsButton.setAttribute('aria-expanded', 'false');
    }
}

// --- Animation loop ---

function animate() {
    requestAnimationFrame(animate);
    const deltaTime = clock.getDelta();

    switch (phase) {
        case Phase.CAM_IN:
            camera.position.lerp(ballCamStartPosition, frameLerp(BALL_CAM_TRANSITION_SPEED, deltaTime));
            camera.lookAt(ballCamStartLookAt);
            if (camera.position.distanceTo(ballCamStartPosition) < 0.1) {
                camera.position.copy(ballCamStartPosition);
                startFlight();
            }
            break;

        case Phase.FLYING:
            serve.advance(Math.min(deltaTime, MAX_FRAME_DELTA));
            view.setBall(serve.position, serve.orientation);
            if (serve.finished) {
                endFlight();
            } else {
                trajectoryPoints.push(serve.position.clone());
                if (serveUsesBallCam) followBall(deltaTime);
            }
            break;

        case Phase.CAM_HOLD:
            if (performance.now() - ballCamEndTime > BALL_CAM_END_DELAY) {
                phase = Phase.CAM_OUT;
                updateUIState();
            }
            break;

        case Phase.CAM_OUT: {
            const alpha = frameLerp(BALL_CAM_TRANSITION_SPEED, deltaTime);
            camera.position.lerp(preBallCamPosition, alpha);
            controls.target.lerp(preBallCamTarget, alpha);
            // Controls are disabled here, so update them manually to keep the camera aimed at the target
            controls.update();
            if (camera.position.distanceTo(preBallCamPosition) < 0.1 && controls.target.distanceTo(preBallCamTarget) < 0.1) {
                camera.position.copy(preBallCamPosition);
                controls.target.copy(preBallCamTarget);
                controls.enabled = true;
                phase = Phase.IDLE;
                showIdleArrow();
                updateUIState();
            }
            break;
        }
    }

    if (controls.enabled) controls.update(); // Damping
    view.render();
}

// --- Start ---
setupUIListeners();
collapseOnSmallScreens();
generateSaveLoadButtons();
updateValueDisplays();
resetToSettings();
setCameraPosition('behind');
updateUIState();
animate();
