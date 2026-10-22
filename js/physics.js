// Ball flight physics. No DOM or rendering code, so it runs in the browser and in Node tests.
import { Vector3, Quaternion, MathUtils } from 'three';
import {
    COURT_WIDTH, COURT_LENGTH, NET_HEIGHT_MEN, NET_HEIGHT_WOMEN, NET_LENGTH, NET_VISUAL_HEIGHT,
    NET_BAND_HEIGHT, ANTENNA_HEIGHT, ANTENNA_RADIUS, BALL_RADIUS, BALL_MASS, BALL_AREA, GRAVITY,
    AIR_DENSITY, SERVE_DISTANCE_BEHIND_BASELINE, CORNER_INSET,
} from './constants.js';

// Integration (fixed step => identical results at any frame rate)
export const PHYSICS_DT = 0.001; // s
export const MAX_FLIGHT_TIME = 10; // s, safety stop

// Air drag. Above a critical Reynolds number the boundary layer turns turbulent, separates later and
// drag drops sharply ("drag crisis"). A float serve starts above and ends below it, so it brakes late.
const AIR_KINEMATIC_VISCOSITY = 1.5e-5; // m^2/s at ~20 °C
const CONSTANT_DRAG_COEFFICIENT = 0.45; // 'constant' drag model
const DRAG_SUBCRITICAL = 0.45;          // 'custom' model: slow ball, laminar boundary layer
const DRAG_SUPERCRITICAL = 0.18;        // 'custom' model: fast ball, turbulent boundary layer
const DRAG_TRANSITION_WIDTH = 0.06;     // 'custom' model: transition width relative to the critical Reynolds number

// Measured drag curves as [air speed (m/s), Cd], interpolated linearly and held constant beyond the ends.
// Source: Dumek & Urban, "Measurement of Surface Roughness of Volleyball", Acta Mechanica Slovaca 22 (2018),
// Fig. 4 (read off the chart). Reynolds numbers there are converted to speed with the diameters of their
// Table 1 (VLS 300: 0.24 m, MVA 200: 0.218 m) and ν = 1.5e-5 m²/s; for the VLS 300 this maps the data onto
// the 10-25 m/s range of the wind tunnel. Points marked "assumed" are not measured.
export const DRAG_CURVES = {
    vls300: [ // Mikasa VLS 300, official FIVB beach ball
        [0, 0.45], [7.5, 0.45], // assumed: subcritical plateau, extrapolated from the measured slope
        [10.3, 0.35], [15.4, 0.155], [17.5, 0.17], [19.5, 0.175], [21.6, 0.185], [25.8, 0.18],
    ],
    mva200: [ // Mikasa MVA 200, indoor ball
        [5.9, 0.465], [8.6, 0.455], [10.3, 0.437], [11.8, 0.45], [12.3, 0.435], [12.7, 0.407], [13.8, 0.363],
        [14.6, 0.307], [15.7, 0.27], [16.5, 0.238], [17.5, 0.211], [19.7, 0.178], [21.3, 0.136], [23.4, 0.138],
        [25.3, 0.143], [27.0, 0.146], [29.1, 0.162],
    ],
};

// dragModel: 'vls300' | 'mva200' (measured), 'custom' (drag crisis at criticalSpeed, m/s), 'constant'.
// knuckleStrength: typical side-force coefficient of a non-spinning ball.
// crisisShift: how far the panel orientation moves the drag crisis (relative, ±).
export const DEFAULT_AERO = { dragModel: 'vls300', criticalSpeed: 12, knuckleStrength: 0.09, crisisShift: 0.07 };

// Knuckling: without spin, the panels and seams stay in place relative to the airflow and the air separates
// unevenly, pushing the ball sideways. The push depends on how the ball's surface faces the flow, so it
// changes as the ball slowly turns. Spin averages it out. Wind tunnel data for the Mikasa VLS 300 at 0 rps
// (Dumek & Šafařík, EPJ Web of Conferences 180, 02021 (2018), Figs. 7 and 9) shows lift and side force
// coefficients of roughly ±0.05-0.1. A hitting robot serving non-rotating balls at 15 m/s over 15 m measured a
// lateral landing scatter (SD) of 42-72 cm (Hong et al., ISBS 2018); the default strength gives ~40 cm, a bit
// below, because the robot's own inaccuracy is part of that scatter. The same study found that the panel
// orientation moves the critical Reynolds number: ±7% for a Mikasa, up to ±17% for 18-panel balls.
const KNUCKLE_SPIN_SCALE = 0.02;       // Spin parameter Rω/v at which the knuckle force has halved
const MAX_RESIDUAL_SPIN = 0.5;         // rev/s, leftover spin of a float serve (set per serve by the seed)
const SURFACE_PATTERN_SEED = 10;       // Fixed: the pattern belongs to the ball, not to the serve
const SURFACE_PATTERN_TERMS = 12;

// Net tape interaction
const COR_NET_TAPE = 0.3;       // Coefficient of restitution of the tape (normal direction)
const TAPE_FRICTION = 0.4;      // Coulomb friction coefficient at the tape
const MIN_BOUNCE_SPEED = 0.2;   // Below this normal speed, contacts are treated as resting (no bounce)

// Typical reception positions on the opponent's side (two receivers)
export const RECEIVER_POSITIONS = [
    new Vector3(COURT_LENGTH * 0.3, 0, COURT_WIDTH * 0.25),
    new Vector3(COURT_LENGTH * 0.3, 0, -COURT_WIDTH * 0.25),
];

// Serve presets per gender. Each lands about 6 m past the net (center position, no wind, no knuckle,
// VLS 300 drag) and clears the net by 0.3 - 0.8 m.
export const SERVE_PRESETS = {
    float: {
        male: { contactHeight: 2.6, launchSpeed: 14.5, verticalAngle: 17, spin: 0 },
        female: { contactHeight: 2.4, launchSpeed: 15, verticalAngle: 15, spin: 0 },
    },
    jumpFloat: {
        male: { contactHeight: 3.0, launchSpeed: 15.5, verticalAngle: 10, spin: 0 },
        female: { contactHeight: 2.8, launchSpeed: 16, verticalAngle: 9, spin: 0 },
    },
    topspinJump: {
        male: { contactHeight: 3.2, launchSpeed: 18.5, verticalAngle: 10, spin: 8 },
        female: { contactHeight: 3.0, launchSpeed: 21, verticalAngle: 7, spin: 8 },
    },
};

const UP = new Vector3(0, 1, 0);

// --- Settings helpers ---

export function netHeightFor(gender) {
    return gender === 'female' ? NET_HEIGHT_WOMEN : NET_HEIGHT_MEN;
}

// Ball center at contact for the given launch position ('center', 'leftCorner', 'rightCorner')
export function servePosition(launchPosition, contactHeight) {
    const x = -COURT_LENGTH / 2 - SERVE_DISTANCE_BEHIND_BASELINE;
    switch (launchPosition) {
        case 'leftCorner': // Server's left = -Z
            return new Vector3(x, contactHeight, -COURT_WIDTH / 2 + CORNER_INSET);
        case 'rightCorner': // Server's right = +Z
            return new Vector3(x, contactHeight, COURT_WIDTH / 2 - CORNER_INSET);
        default:
            return new Vector3(x, contactHeight, 0);
    }
}

// Unit launch direction; positive horizontal angle = to the server's right (+Z)
export function launchDirection(verticalDeg, horizontalDeg) {
    const dir = new Vector3(1, 0, 0);
    dir.applyAxisAngle(new Vector3(0, 0, 1), MathUtils.degToRad(verticalDeg)); // Pitch
    dir.applyAxisAngle(UP, -MathUtils.degToRad(horizontalDeg));                // Yaw
    return dir.normalize();
}

// Velocity of the air; direction is where the wind blows towards (0° = +X towards net, 90° = +Z right)
export function windVelocityFrom(enabled, speed, directionDeg) {
    if (!enabled) return new Vector3();
    const a = MathUtils.degToRad(directionDeg);
    return new Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(speed);
}

export function reynoldsNumber(speed) {
    return speed * 2 * BALL_RADIUS / AIR_KINEMATIC_VISCOSITY;
}

function interpolateCurve(curve, x) {
    if (x <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
        const [x1, y1] = curve[i];
        if (x <= x1) {
            const [x0, y0] = curve[i - 1];
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
    }
    return curve.at(-1)[1];
}

// Drag coefficient for the speed of the ball relative to the air
export function dragCoefficient(relSpeed, aero = DEFAULT_AERO) {
    const curve = DRAG_CURVES[aero.dragModel];
    if (curve) return interpolateCurve(curve, relSpeed);
    if (aero.dragModel === 'constant') return CONSTANT_DRAG_COEFFICIENT;

    const criticalRe = reynoldsNumber(aero.criticalSpeed);
    const x = (reynoldsNumber(relSpeed) - criticalRe) / (DRAG_TRANSITION_WIDTH * criticalRe);
    return DRAG_SUPERCRITICAL + (DRAG_SUBCRITICAL - DRAG_SUPERCRITICAL) / (1 + Math.exp(x));
}

// --- Knuckle force ---

// Small deterministic PRNG (mulberry32); returns a function giving floats in [0, 1)
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomUnitVector(random) {
    const z = 2 * random() - 1;
    const phi = 2 * Math.PI * random();
    const r = Math.sqrt(1 - z * z);
    return new Vector3(r * Math.cos(phi), r * Math.sin(phi), z);
}

// The ball's surface as a smooth random field on the sphere, evaluated at the point facing the flow (in the
// ball's own frame). Its tangential gradient gives the side force; its value (-1..1) shifts the drag crisis.
const surfacePattern = (() => {
    const random = seededRandom(SURFACE_PATTERN_SEED);
    const terms = Array.from({ length: SURFACE_PATTERN_TERMS }, () => ({
        normal: randomUnitVector(random),
        frequency: 1.5 + 2.5 * random(), // Features roughly the size of the panels
        phase: 2 * Math.PI * random(),
        amplitude: 0.5 + random(),
    }));

    // Tangential gradient of the field at unit direction d (written to out)
    function gradient(d, out) {
        out.set(0, 0, 0);
        for (const { normal, frequency, phase, amplitude } of terms) {
            out.addScaledVector(normal, -amplitude * frequency * Math.sin(frequency * normal.dot(d) + phase));
        }
        return out.addScaledVector(d, -out.dot(d)); // Remove the radial part
    }

    function value(d) {
        let sum = 0;
        for (const { normal, frequency, phase, amplitude } of terms) {
            sum += amplitude * Math.cos(frequency * normal.dot(d) + phase);
        }
        return sum;
    }

    // Normalise: RMS side-force coefficient 1 over all orientations, values within -1..1
    const sampler = seededRandom(SURFACE_PATTERN_SEED + 1);
    const g = new Vector3();
    let sumSq = 0;
    let maxValue = 0;
    const samples = 4000;
    for (let i = 0; i < samples; i++) {
        const d = randomUnitVector(sampler);
        sumSq += gradient(d, g).lengthSq();
        maxValue = Math.max(maxValue, Math.abs(value(d)));
    }
    const gradientScale = 1 / Math.sqrt(sumSq / samples);

    return {
        sideForce: (d, out) => gradient(d, out).multiplyScalar(gradientScale),
        value: d => MathUtils.clamp(value(d) / maxValue, -1, 1),
    };
})();

// How the ball leaves the hand on a float serve: orientation of its panels and a small leftover spin
export function floatContact(seed) {
    const random = seededRandom(seed);
    // Uniform random orientation (Shoemake)
    const [u1, u2, u3] = [random(), random(), random()];
    const orientation = new Quaternion(
        Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
        Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
        Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
        Math.sqrt(u1) * Math.cos(2 * Math.PI * u3)
    );
    const residualSpin = randomUnitVector(random).multiplyScalar(MAX_RESIDUAL_SPIN * random() * 2 * Math.PI); // rad/s
    return { orientation, residualSpin };
}

// --- Classification and scoring ---

// The ball is in when its contact point touches the court, lines included
export function classifyLanding({ x, z, crossedNet, touchedTape, pendingFault }) {
    if (pendingFault) return pendingFault;
    if (!crossedNet || x <= 0) return touchedTape ? 'Net Hit (Fell Back)' : "Didn't Cross Net";

    const isLong = x > COURT_LENGTH / 2;
    const isWide = Math.abs(z) > COURT_WIDTH / 2;
    if (isLong && isWide) return 'Out (Long & Wide)';
    if (isLong) return 'Out (Long)';
    if (isWide) return 'Out (Wide)';
    return 'In';
}

// 0-100; only "In" serves score. Faster, shorter, farther from the receivers and more knuckle drift is harder.
export function difficultyScore({ classification, speed, time, position, drift = 0 }) {
    if (classification !== 'In') return 0;

    const landing = new Vector3(position.x, 0, position.z);
    const distanceToReceiver = Math.min(...RECEIVER_POSITIONS.map(p => landing.distanceTo(p)));

    const speedScore = MathUtils.clamp((speed - 10) / (28 - 10), 0, 1);
    const timeScore = MathUtils.clamp((1.8 - time) / (1.8 - 0.6), 0, 1);
    const positionScore = MathUtils.clamp(distanceToReceiver / 3.5, 0, 1);
    const driftScore = MathUtils.clamp(drift / 0.5, 0, 1); // Unpredictable path

    return Math.round((speedScore * 0.4 + timeScore * 0.2 + positionScore * 0.25 + driftScore * 0.15) * 100);
}

// --- Simulation ---

export class ServeSimulation {
    // position/velocity: Vector3 at contact; spin: rev/s, positive = topspin; windVelocity: Vector3 (m/s);
    // aero: { dragModel, criticalSpeed, knuckleStrength }; floatSeed: panel orientation and leftover spin
    constructor({ position, velocity, netHeight, windVelocity = new Vector3(), spin = 0, aero = DEFAULT_AERO, floatSeed = 1 }) {
        this.position = position.clone();
        this.prevPosition = position.clone();
        this.velocity = velocity.clone();
        this.netHeight = netHeight;
        this.windVelocity = windVelocity.clone();
        this.aero = { ...DEFAULT_AERO, ...aero };
        this.time = 0;

        // Spin axis is horizontal and perpendicular to the serve direction:
        // positive spin = topspin (ball dips), negative = backspin (ball floats)
        const horizontalDir = new Vector3(velocity.x, 0, velocity.z).normalize();
        const contact = floatContact(floatSeed);
        this.angularVelocity = new Vector3().crossVectors(UP, horizontalDir).normalize()
            .multiplyScalar(spin * 2 * Math.PI) // rad/s, world frame
            .add(contact.residualSpin);
        this.orientation = contact.orientation; // Ball orientation (knuckle force and rendering)

        this.crossedNet = false;
        this.touchedTape = false;
        this.pendingFault = null; // Fault at the net plane; the flight continues until landing
        this.result = null;       // Set when the flight ends
        this.accumulator = 0;

        // Scratch vectors
        this._accel = new Vector3();
        this._relVel = new Vector3();
        this._force = new Vector3();
        this._closest = new Vector3();
        this._normal = new Vector3();
        this._spinStep = new Quaternion();
        this._flowDir = new Vector3();
        this._inverseOrientation = new Quaternion();
    }

    get finished() {
        return this.result !== null;
    }

    // Advances by wall-clock seconds using fixed steps; returns the number of steps taken
    advance(seconds) {
        this.accumulator += seconds;
        let steps = 0;
        while (!this.finished && this.accumulator >= PHYSICS_DT) {
            this.step();
            this.accumulator -= PHYSICS_DT;
            steps++;
        }
        return steps;
    }

    // Runs until the ball stops; optional callback receives the simulation after every step
    runToEnd(onStep) {
        while (!this.finished) {
            this.step();
            if (onStep) onStep(this);
        }
        return this.result;
    }

    // Acceleration for a given velocity: gravity + drag + Magnus, wind via the velocity relative to the air
    acceleration(velocity, out) {
        out.set(0, -GRAVITY * BALL_MASS, 0);

        const relVel = this._relVel.copy(velocity).sub(this.windVelocity);
        const relSpeedSq = relVel.lengthSq();
        if (relSpeedSq > 1e-8) {
            const relSpeed = Math.sqrt(relSpeedSq);
            const dynamicPressureArea = 0.5 * AIR_DENSITY * BALL_AREA * relSpeedSq;
            const spinRate = this.angularVelocity.length();
            const spinParameter = spinRate * BALL_RADIUS / relSpeed;

            // Panel effects only act while the panels stay put relative to the flow; spin averages them out
            const panelEffect = 1 / (1 + (spinParameter / KNUCKLE_SPIN_SCALE) ** 2);
            const flowInBallFrame = this._flowDir.copy(relVel).divideScalar(-relSpeed)
                .applyQuaternion(this._inverseOrientation.copy(this.orientation).invert());

            // Drag: opposite to the velocity relative to the air. The panel orientation moves the drag crisis.
            const crisisFactor = 1 + this.aero.crisisShift * panelEffect * surfacePattern.value(flowInBallFrame);
            out.addScaledVector(relVel, -dragCoefficient(relSpeed / crisisFactor, this.aero) * dynamicPressureArea / relSpeed);

            // Magnus: perpendicular to the spin axis and the relative velocity
            if (spinRate > 0) {
                const liftCoefficient = 1 / (2 + 1 / spinParameter); // Sphere fit; ≈0.3 at s = 0.85 as measured for the VLS 300
                this._force.crossVectors(this.angularVelocity, relVel).normalize()
                    .multiplyScalar(liftCoefficient * dynamicPressureArea);
                out.add(this._force);
            }

            // Knuckle: side force from the panels facing the flow
            if (this.aero.knuckleStrength > 0) {
                surfacePattern.sideForce(flowInBallFrame, this._force).applyQuaternion(this.orientation);
                out.addScaledVector(this._force, this.aero.knuckleStrength * panelEffect * dynamicPressureArea);
            }
        }
        return out.divideScalar(BALL_MASS);
    }

    // One fixed step (semi-implicit Euler)
    step() {
        if (this.finished) return;
        this.prevPosition.copy(this.position);
        this.velocity.addScaledVector(this.acceleration(this.velocity, this._accel), PHYSICS_DT);
        this.position.addScaledVector(this.velocity, PHYSICS_DT);
        this.time += PHYSICS_DT;

        const spinRate = this.angularVelocity.length();
        if (spinRate > 0) {
            this._spinStep.setFromAxisAngle(this._normal.copy(this.angularVelocity).divideScalar(spinRate), spinRate * PHYSICS_DT);
            this.orientation.premultiply(this._spinStep);
        }

        this.checkCollisions();

        if (!this.finished && this.time >= MAX_FLIGHT_TIME) this.finish('Timeout', 'Speed');
    }

    finish(classification, speedLabel) {
        this.result = {
            classification,
            speedLabel,
            speed: this.velocity.length(),
            time: this.time,
            position: this.position.clone(),
            touchedTape: this.touchedTape,
        };
    }

    checkCollisions() {
        const pos = this.position;
        const prev = this.prevPosition;
        const netHeight = this.netHeight;

        // 1. Ground: interpolate back to the exact moment the ball touches the sand
        if (pos.y <= BALL_RADIUS) {
            const t = (prev.y - BALL_RADIUS) / (prev.y - pos.y);
            pos.lerpVectors(prev, pos, MathUtils.clamp(t, 0, 1));
            pos.y = BALL_RADIUS;
            this.finish(classifyLanding({
                x: pos.x, z: pos.z,
                crossedNet: this.crossedNet, touchedTape: this.touchedTape, pendingFault: this.pendingFault,
            }), 'Landing Speed');
            return;
        }

        // 2. Antennas: vertical cylinders from the net bottom to ANTENNA_HEIGHT above the net
        const antennaBottomY = netHeight - NET_VISUAL_HEIGHT;
        const antennaTopY = netHeight + ANTENNA_HEIGHT;
        for (const antennaZ of [COURT_WIDTH / 2, -COURT_WIDTH / 2]) {
            this._closest.set(0, MathUtils.clamp(pos.y, antennaBottomY, antennaTopY), antennaZ);
            if (pos.distanceTo(this._closest) < BALL_RADIUS + ANTENNA_RADIUS) {
                this.finish('Antenna Hit', 'Impact Speed');
                return;
            }
        }

        // 3. Net: a vertical rectangle in the plane x = 0; the top NET_BAND_HEIGHT is the tape
        const closest = this._closest.set(
            0,
            MathUtils.clamp(pos.y, netHeight - NET_VISUAL_HEIGHT, netHeight),
            MathUtils.clamp(pos.z, -NET_LENGTH / 2, NET_LENGTH / 2)
        );
        if (pos.distanceTo(closest) < BALL_RADIUS) {
            if (Math.abs(pos.z) > COURT_WIDTH / 2) {
                // Touching the net outside the antennas is a fault
                this.finish('Out (Net Outside Antennas)', 'Impact Speed');
                return;
            }
            if (closest.y < netHeight - NET_BAND_HEIGHT) {
                this.finish('Net Hit', 'Impact Speed');
                return;
            }
            this.handleTapeContact(closest);
        }

        // 4. Crossing the vertical plane of the net
        if (!this.crossedNet && prev.x < 0 && pos.x >= 0) {
            this.crossedNet = true;
            const t = -prev.x / (pos.x - prev.x);
            const crossY = MathUtils.lerp(prev.y, pos.y, t);
            const crossZ = Math.abs(MathUtils.lerp(prev.z, pos.z, t));
            const antennaClearance = BALL_RADIUS + ANTENNA_RADIUS;

            // The crossing space is bounded by the antennas and their imaginary extension upwards
            if (crossZ >= COURT_WIDTH / 2 + antennaClearance) {
                this.pendingFault = 'Out (Outside Antennas)';
            } else if (crossZ > COURT_WIDTH / 2 - antennaClearance) {
                this.pendingFault = 'Out (Over Antenna)';
            } else if (crossY < netHeight) {
                this.pendingFault = 'Out (Under Net)';
            }
        }
    }

    // Ball touches the net tape: impulse-based contact with restitution and Coulomb friction.
    // Depending on where the tape is hit, the ball bounces back or rolls over.
    handleTapeContact(contactPoint) {
        this.touchedTape = true;
        const normal = this._normal.copy(this.position).sub(contactPoint);
        const dist = normal.length();
        if (dist < 1e-6) {
            normal.set(-Math.sign(this.velocity.x) || -1, 0, 0);
        } else {
            normal.divideScalar(dist);
        }

        // Push the ball out of the tape
        this.position.copy(contactPoint).addScaledVector(normal, BALL_RADIUS);

        const vn = this.velocity.dot(normal);
        if (vn >= 0) return; // Already separating

        const isImpact = -vn > MIN_BOUNCE_SPEED;
        const restitution = isImpact ? COR_NET_TAPE : 0;
        const normalImpulse = -(1 + restitution) * vn; // Velocity change along the normal

        const tangential = this.velocity.clone().addScaledVector(normal, -vn);
        const tangentialSpeed = tangential.length();

        this.velocity.addScaledVector(normal, normalImpulse);
        // Friction only on impacts: a ball resting on the tape rolls off instead of sticking to it
        if (isImpact && tangentialSpeed > 1e-6) {
            const frictionDelta = Math.min(TAPE_FRICTION * normalImpulse, tangentialSpeed);
            this.velocity.addScaledVector(tangential, -frictionDelta / tangentialSpeed);
        }
    }
}

// Builds a simulation from a plain settings object (as stored in save slots)
export function createServe(settings) {
    const direction = launchDirection(settings.verticalAngle, settings.horizontalAngle);
    return new ServeSimulation({
        position: servePosition(settings.launchPosition, settings.contactHeight),
        velocity: direction.multiplyScalar(settings.launchSpeed),
        netHeight: netHeightFor(settings.gender),
        windVelocity: windVelocityFrom(settings.windEnabled, settings.windStrength, settings.windDirection),
        spin: settings.spin,
        aero: {
            dragModel: settings.dragModel ?? DEFAULT_AERO.dragModel,
            criticalSpeed: settings.criticalSpeed ?? DEFAULT_AERO.criticalSpeed,
            knuckleStrength: settings.knuckleStrength ?? DEFAULT_AERO.knuckleStrength,
            crisisShift: settings.crisisShift ?? DEFAULT_AERO.crisisShift,
        },
        floatSeed: settings.floatSeed ?? 1,
    });
}

// Flight of the same serve without panel effects ("ghost": no knuckle force, no crisis shift), and the knuckle drift: the largest
// distance between the real ball and the ghost at the same moment. The drift is null when either ball
// touched the net tape, because the contact, not the knuckle, then decides the difference.
export function predictFloat(settings, sampleEvery = 10) {
    const real = createServe(settings);
    const ghost = createServe({ ...settings, knuckleStrength: 0, crisisShift: 0 });
    const ghostPoints = [ghost.position.clone()];
    let drift = 0;
    let steps = 0;
    while (!ghost.finished) {
        ghost.step();
        if (!real.finished) {
            real.step();
            if (!real.finished) drift = Math.max(drift, real.position.distanceTo(ghost.position));
        }
        if (++steps % sampleEvery === 0 || ghost.finished) ghostPoints.push(ghost.position.clone());
    }
    real.runToEnd();
    if (real.touchedTape || ghost.touchedTape) drift = null;
    return { ghostPoints, drift };
}
