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

const DRAG_COEFFICIENT = 0.45; // Typical measured volleyball value at serve speeds (subcritical regime)

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
    // position/velocity: Vector3 at contact; spin: rev/s, positive = topspin; windVelocity: Vector3 (m/s)
    constructor({ position, velocity, netHeight, windVelocity = new Vector3(), spin = 0 }) {
        this.position = position.clone();
        this.prevPosition = position.clone();
        this.velocity = velocity.clone();
        this.netHeight = netHeight;
        this.windVelocity = windVelocity.clone();
        this.time = 0;

        // Spin axis is horizontal and perpendicular to the serve direction:
        // positive spin = topspin (ball dips), negative = backspin (ball floats)
        const horizontalDir = new Vector3(velocity.x, 0, velocity.z).normalize();
        this.angularVelocity = new Vector3().crossVectors(UP, horizontalDir).normalize()
            .multiplyScalar(spin * 2 * Math.PI); // rad/s, world frame
        this.orientation = new Quaternion(); // Ball orientation, for rendering

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
            out.addScaledVector(relVel, -DRAG_COEFFICIENT * dynamicPressureArea / relSpeed);

            // Magnus: perpendicular to the spin axis and the relative velocity
            const spinRate = this.angularVelocity.length();
            if (spinRate > 0) {
                const spinParameter = spinRate * BALL_RADIUS / relSpeed;
                const liftCoefficient = 1 / (2 + 1 / spinParameter); // Empirical sphere fit
                this._force.crossVectors(this.angularVelocity, relVel).normalize()
                    .multiplyScalar(liftCoefficient * dynamicPressureArea);
                out.add(this._force);
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
    });
}
