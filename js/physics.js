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
// The values are estimates for a volleyball; the critical speed depends on the ball's surface.
const AIR_KINEMATIC_VISCOSITY = 1.5e-5; // m^2/s at ~20 °C
const CONSTANT_DRAG_COEFFICIENT = 0.45; // Used when the drag crisis is switched off
const DRAG_SUBCRITICAL = 0.5;           // Slow ball: laminar boundary layer
const DRAG_SUPERCRITICAL = 0.2;         // Fast ball: turbulent boundary layer
const DRAG_TRANSITION_WIDTH = 0.06;     // Width of the transition, relative to the critical Reynolds number
// criticalSpeed in m/s; knuckleStrength = typical side-force coefficient of a non-spinning ball
export const DEFAULT_AERO = { dragCrisis: true, criticalSpeed: 17, knuckleStrength: 0.06 };

// Knuckling: without spin, the panels and seams stay in place relative to the airflow and the air separates
// unevenly, pushing the ball sideways. The push depends on how the ball's surface faces the flow, so it
// changes as the ball slowly turns. Spin averages it out.
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

// Drag coefficient for the speed of the ball relative to the air
export function dragCoefficient(relSpeed, aero = DEFAULT_AERO) {
    if (!aero.dragCrisis) return CONSTANT_DRAG_COEFFICIENT;
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

// The ball's surface as a smooth random field on the sphere. Its tangential gradient at the point
// facing the flow gives the direction and size of the side force, in the ball's own frame.
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

    // Normalise so that the RMS side-force coefficient over all orientations is 1
    const sampler = seededRandom(SURFACE_PATTERN_SEED + 1);
    const g = new Vector3();
    let sumSq = 0;
    const samples = 4000;
    for (let i = 0; i < samples; i++) sumSq += gradient(randomUnitVector(sampler), g).lengthSq();
    const scale = 1 / Math.sqrt(sumSq / samples);

    return (d, out) => gradient(d, out).multiplyScalar(scale);
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

// 0-100; only "In" serves score. Faster, shorter and farther from the receivers is harder.
export function difficultyScore({ classification, speed, time, position }) {
    if (classification !== 'In') return 0;

    const landing = new Vector3(position.x, 0, position.z);
    const distanceToReceiver = Math.min(...RECEIVER_POSITIONS.map(p => landing.distanceTo(p)));

    const speedScore = MathUtils.clamp((speed - 10) / (28 - 10), 0, 1);
    const timeScore = MathUtils.clamp((1.8 - time) / (1.8 - 0.6), 0, 1);
    const positionScore = MathUtils.clamp(distanceToReceiver / 3.5, 0, 1);

    return Math.round((speedScore * 0.45 + timeScore * 0.25 + positionScore * 0.30) * 100);
}

// --- Simulation ---

export class ServeSimulation {
    // position/velocity: Vector3 at contact; spin: rev/s, positive = topspin; windVelocity: Vector3 (m/s);
    // aero: { dragCrisis, criticalSpeed, knuckleStrength }; floatSeed: panel orientation and leftover spin
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

            // Drag: opposite to the velocity relative to the air
            out.addScaledVector(relVel, -dragCoefficient(relSpeed, this.aero) * dynamicPressureArea / relSpeed);

            // Magnus: perpendicular to the spin axis and the relative velocity
            const spinRate = this.angularVelocity.length();
            if (spinRate > 0) {
                const spinParameter = spinRate * BALL_RADIUS / relSpeed;
                const liftCoefficient = 1 / (2 + 1 / spinParameter); // Empirical sphere fit
                this._force.crossVectors(this.angularVelocity, relVel).normalize()
                    .multiplyScalar(liftCoefficient * dynamicPressureArea);
                out.add(this._force);
            }

            // Knuckle: side force from the panels facing the flow, damped by spin
            if (this.aero.knuckleStrength > 0) {
                const spinParameter = spinRate * BALL_RADIUS / relSpeed;
                const damping = 1 / (1 + (spinParameter / KNUCKLE_SPIN_SCALE) ** 2);
                const flowInBallFrame = this._flowDir.copy(relVel).divideScalar(-relSpeed)
                    .applyQuaternion(this._inverseOrientation.copy(this.orientation).invert());
                surfacePattern(flowInBallFrame, this._force).applyQuaternion(this.orientation);
                out.addScaledVector(this._force, this.aero.knuckleStrength * damping * dynamicPressureArea);
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

        const restitution = -vn > MIN_BOUNCE_SPEED ? COR_NET_TAPE : 0;
        const normalImpulse = -(1 + restitution) * vn; // Velocity change along the normal

        const tangential = this.velocity.clone().addScaledVector(normal, -vn);
        const tangentialSpeed = tangential.length();

        this.velocity.addScaledVector(normal, normalImpulse);
        if (tangentialSpeed > 1e-6) {
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
            dragCrisis: settings.dragCrisis ?? DEFAULT_AERO.dragCrisis,
            criticalSpeed: settings.criticalSpeed ?? DEFAULT_AERO.criticalSpeed,
            knuckleStrength: settings.knuckleStrength ?? DEFAULT_AERO.knuckleStrength,
        },
        floatSeed: settings.floatSeed ?? 1,
    });
}
