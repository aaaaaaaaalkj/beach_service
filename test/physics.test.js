import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
    ServeSimulation, createServe, classifyLanding, difficultyScore, netHeightFor, dragCoefficient, predictFloat, SERVE_PRESETS,
} from '../js/physics.js';
import { COURT_WIDTH, COURT_LENGTH, BALL_RADIUS, NET_HEIGHT_MEN, ANTENNA_HEIGHT } from '../js/constants.js';

const BASE = {
    gender: 'male', launchPosition: 'center', contactHeight: 2.2, launchSpeed: 15, verticalAngle: 20,
    horizontalAngle: 0, spin: 0, windEnabled: false, windStrength: 0, windDirection: 0,
};
const serve = overrides => createServe({ ...BASE, ...overrides });

// Ball released 1 m in front of the net plane, flying straight towards it
function shotAtNet(y, z, speed = 10) {
    return new ServeSimulation({
        position: new Vector3(-1, y, z),
        velocity: new Vector3(speed, 0, 0),
        netHeight: NET_HEIGHT_MEN,
    }).runToEnd();
}

test('line calls: a ball touching the line is in', () => {
    const land = (x, z) => classifyLanding({ x, z, crossedNet: true, touchedTape: false, pendingFault: null });
    assert.equal(land(4, COURT_WIDTH / 2 - 0.01), 'In');
    assert.equal(land(4, -COURT_WIDTH / 2), 'In');
    assert.equal(land(COURT_LENGTH / 2, 0), 'In');
    assert.equal(land(4, COURT_WIDTH / 2 + 0.01), 'Out (Wide)');
    assert.equal(land(COURT_LENGTH / 2 + 0.01, 0), 'Out (Long)');
    assert.equal(land(COURT_LENGTH / 2 + 1, COURT_WIDTH), 'Out (Long & Wide)');
});

test('landing on the own side', () => {
    assert.equal(classifyLanding({ x: -2, z: 0, crossedNet: false, touchedTape: false }), "Didn't Cross Net");
    assert.equal(classifyLanding({ x: -0.5, z: 0, crossedNet: false, touchedTape: true }), 'Net Hit (Fell Back)');
});

test('a fault at the net plane wins over the landing spot', () => {
    assert.equal(classifyLanding({ x: 4, z: 0, crossedNet: true, pendingFault: 'Out (Under Net)' }), 'Out (Under Net)');
});

test('net, antenna and crossing-space faults', () => {
    assert.equal(shotAtNet(NET_HEIGHT_MEN - 0.5, 0).classification, 'Net Hit');
    assert.equal(shotAtNet(NET_HEIGHT_MEN + 0.4, COURT_WIDTH / 2).classification, 'Antenna Hit');
    assert.equal(shotAtNet(NET_HEIGHT_MEN + ANTENNA_HEIGHT + 0.4, COURT_WIDTH / 2 - 0.05).classification, 'Out (Over Antenna)');
    assert.equal(shotAtNet(NET_HEIGHT_MEN + 0.5, COURT_WIDTH / 2 + 0.5).classification, 'Out (Outside Antennas)');
    assert.equal(shotAtNet(0.8, 0).classification, 'Out (Under Net)');
    assert.equal(shotAtNet(NET_HEIGHT_MEN - 0.5, COURT_WIDTH / 2 + 0.15).classification, 'Out (Net Outside Antennas)');
});

test('impact results are labelled as impact speed', () => {
    const result = shotAtNet(NET_HEIGHT_MEN - 0.5, 0);
    assert.equal(result.speedLabel, 'Impact Speed');
    assert.equal(serve({}).runToEnd().speedLabel, 'Landing Speed');
});

test('a serve that is "In" crossed above the net (no tunnelling)', () => {
    for (let speed = 10; speed <= 30; speed += 2) {
        for (let angle = 1; angle <= 30; angle += 3) {
            let crossY = null;
            const result = serve({ launchSpeed: speed, verticalAngle: angle }).runToEnd(sim => {
                if (crossY === null && sim.prevPosition.x < 0 && sim.position.x >= 0) crossY = sim.position.y;
            });
            if (result.classification === 'In') {
                assert.ok(crossY >= NET_HEIGHT_MEN, `speed ${speed}, angle ${angle}: crossed at ${crossY}`);
            }
        }
    }
});

test('a ball never stays on the tape', () => {
    for (let seed = 1; seed <= 300; seed++) {
        const result = serve({ ...SERVE_PRESETS.jumpFloat.male, floatSeed: seed }).runToEnd();
        assert.notEqual(result.classification, 'Timeout', `seed ${seed}`);
    }
});

test('a ball touching the tape can roll over or fall back', () => {
    const outcomes = new Set();
    for (let h = 2.2; h <= 2.8; h += 0.01) {
        const result = serve({ launchSpeed: 18, verticalAngle: 10, contactHeight: h }).runToEnd();
        if (result.touchedTape) outcomes.add(result.classification);
    }
    assert.ok(outcomes.has('Net Hit (Fell Back)'), [...outcomes].join(', '));
    assert.ok(outcomes.has('In'), [...outcomes].join(', '));
});

test('results do not depend on the frame rate', () => {
    const run = fps => {
        const sim = serve({ launchSpeed: 19, verticalAngle: 9, spin: 6, windEnabled: true, windStrength: 4, windDirection: 30 });
        while (!sim.finished) sim.advance(1 / fps);
        return sim.result;
    };
    const reference = run(60);
    for (const fps of [20, 30, 144]) {
        const result = run(fps);
        assert.equal(result.classification, reference.classification);
        assert.equal(result.time, reference.time);
        assert.ok(result.position.distanceTo(reference.position) < 1e-9);
    }
});

test('the landing point is interpolated to ground contact', () => {
    const result = serve({}).runToEnd();
    assert.equal(result.position.y, BALL_RADIUS);
});

test('wind moves the landing point downwind', () => {
    const landingX = windDirection => serve({ windEnabled: true, windStrength: 5, windDirection, launchSpeed: 13, verticalAngle: 30 })
        .runToEnd().position.x;
    const calm = serve({ launchSpeed: 13, verticalAngle: 30 }).runToEnd().position.x;
    assert.ok(landingX(0) > calm, 'tailwind should carry the ball farther');
    assert.ok(landingX(180) < calm, 'headwind should shorten the serve');

    const crosswindZ = serve({ windEnabled: true, windStrength: 5, windDirection: 90, launchSpeed: 13, verticalAngle: 30 })
        .runToEnd().position.z;
    assert.ok(crosswindZ > 0.1, 'wind towards 90° pushes the ball to the right (+Z)');
});

test('topspin dips, backspin floats', () => {
    const landingX = spin => serve({ launchSpeed: 14, verticalAngle: 25, spin }).runToEnd().position.x;
    assert.ok(landingX(8) < landingX(0));
    assert.ok(landingX(-4) > landingX(0));
});

test('launch positions: left corner is the server\'s left (-Z)', () => {
    assert.ok(serve({ launchPosition: 'leftCorner' }).position.z < 0);
    assert.ok(serve({ launchPosition: 'rightCorner' }).position.z > 0);
    assert.equal(netHeightFor('female'), 2.24);
});

test('difficulty score', () => {
    const result = serve({}).runToEnd();
    assert.equal(result.classification, 'In');
    const score = difficultyScore(result);
    assert.ok(score > 0 && score <= 100);
    assert.equal(difficultyScore({ ...result, classification: 'Out (Long)' }), 0);
});

test('drag curves: measured VLS 300 data and the critical point', () => {
    const vls = v => dragCoefficient(v, { dragModel: 'vls300' });
    assert.equal(vls(15.4), 0.155);                    // Measured minimum
    assert.ok(vls(11.4) > 0.3 && vls(11.8) < 0.3);    // Cd = 0.3 at Re_crit = 186 000 (≈ 11.6 m/s)
    assert.equal(vls(40), 0.18);                       // Held constant beyond the data
    assert.ok(dragCoefficient(20, { dragModel: 'mva200' }) < dragCoefficient(13, { dragModel: 'mva200' }));
    assert.equal(dragCoefficient(25, { dragModel: 'constant' }), 0.45);
});

test('custom drag crisis: drag drops above the critical speed', () => {
    const aero = { dragModel: 'custom', criticalSpeed: 17 };
    assert.ok(Math.abs(dragCoefficient(5, aero) - 0.45) < 0.01);
    assert.ok(Math.abs(dragCoefficient(30, aero) - 0.18) < 0.01);
    assert.ok(Math.abs(dragCoefficient(17, aero) - 0.315) < 1e-9, 'midpoint at the critical speed');
    for (let v = 1; v < 40; v++) assert.ok(dragCoefficient(v + 1, aero) <= dragCoefficient(v, aero));
});

test('drag crisis: a fast float serve carries farther, then brakes harder', () => {
    const settings = { launchSpeed: 17, verticalAngle: 10, contactHeight: 2.8 };
    const withCrisis = serve({ ...settings, dragModel: 'vls300', crisisShift: 0 });
    const constant = serve({ ...settings, dragModel: 'constant', crisisShift: 0 });
    // Early in the flight the supercritical ball has less drag than the constant-drag ball
    for (let i = 0; i < 200; i++) { withCrisis.step(); constant.step(); }
    assert.ok(withCrisis.velocity.length() > constant.velocity.length());
    // Deceleration rises as the ball falls below the critical speed
    const decel = sim => -sim.acceleration(sim.velocity, new Vector3()).dot(sim.velocity.clone().normalize());
    const fast = serve({ ...settings, launchSpeed: 15, crisisShift: 0 });
    const slower = serve({ ...settings, launchSpeed: 11, crisisShift: 0 });
    assert.ok(decel(slower) > decel(fast), 'an 11 m/s ball brakes harder than a 15 m/s ball');
});

// Position where a serve reaches the receiver plane x = 5 m
function atReceiver(settings) {
    let hit = null;
    serve(settings).runToEnd(sim => { if (!hit && sim.position.x >= 5) hit = sim.position.clone(); });
    return hit;
}

test('knuckle: the same ball contact gives the same flight', () => {
    const a = serve({ floatSeed: 42, contactHeight: 2.6, launchSpeed: 17, verticalAngle: 11.5 }).runToEnd();
    const b = serve({ floatSeed: 42, contactHeight: 2.6, launchSpeed: 17, verticalAngle: 11.5 }).runToEnd();
    assert.ok(a.position.distanceTo(b.position) === 0);
    const c = serve({ floatSeed: 43, contactHeight: 2.6, launchSpeed: 17, verticalAngle: 11.5 }).runToEnd();
    assert.ok(a.position.distanceTo(c.position) > 0.01, 'different contacts should float differently');
});

test('knuckle: the side force is perpendicular to the flight direction', () => {
    const settings = { floatSeed: 7, contactHeight: 2.6, launchSpeed: 17, verticalAngle: 11.5 };
    const withKnuckle = serve(settings);
    const without = serve({ ...settings, knuckleStrength: 0 });
    const difference = withKnuckle.acceleration(withKnuckle.velocity, new Vector3())
        .sub(without.acceleration(without.velocity, new Vector3()));
    assert.ok(difference.length() > 0.1, 'knuckle force should be noticeable');
    assert.ok(Math.abs(difference.dot(withKnuckle.velocity.clone().normalize())) < 1e-9);
});

test('knuckle: a float wobbles, spin keeps the ball on its path', () => {
    const medianDeviation = (spin, verticalAngle) => {
        const deviations = [];
        for (let seed = 1; seed <= 60; seed++) {
            const settings = { floatSeed: seed, spin, contactHeight: 2.6, launchSpeed: 17, verticalAngle };
            const real = atReceiver(settings);
            const ghost = atReceiver({ ...settings, knuckleStrength: 0 });
            if (real && ghost) deviations.push(real.distanceTo(ghost));
        }
        deviations.sort((x, y) => x - y);
        return deviations[Math.floor(deviations.length / 2)];
    };
    const float = medianDeviation(0, 11.5);
    const topspin = medianDeviation(8, 21.5);
    assert.ok(float > 0.1 && float < 0.5, `float median deviation ${float}`);
    assert.ok(topspin < 0.02, `topspin median deviation ${topspin}`);
});

test('presets land in for both genders', () => {
    for (const [name, byGender] of Object.entries(SERVE_PRESETS)) {
        for (const [gender, preset] of Object.entries(byGender)) {
            const result = serve({ gender, ...preset, knuckleStrength: 0 }).runToEnd();
            assert.equal(result.classification, 'In', `${name} (${gender})`);
            assert.ok(!result.touchedTape, `${name} (${gender}) should clear the tape`);
        }
    }
});

test('ghost path: drift is zero without knuckling and the ghost is the knuckle-free flight', () => {
    const settings = { ...BASE, ...SERVE_PRESETS.float.male, floatSeed: 3 };
    assert.equal(predictFloat({ ...settings, knuckleStrength: 0, crisisShift: 0 }).drift, 0);

    const { ghostPoints, drift } = predictFloat(settings);
    const ghostLanding = serve({ ...settings, knuckleStrength: 0, crisisShift: 0 }).runToEnd().position;
    assert.ok(ghostPoints.at(-1).distanceTo(ghostLanding) < 1e-9);
    assert.ok(drift > 0);
    assert.equal(predictFloat({ ...settings, spin: 8 }).drift < drift, true, 'spin reduces drift');
});

test('ghost path: no drift value after a net tape contact', () => {
    const tapeSettings = { ...BASE, launchSpeed: 18, verticalAngle: 10, knuckleStrength: 0 };
    let touched = null;
    for (let h = 2.2; h <= 2.8 && !touched; h += 0.01) {
        if (serve({ ...tapeSettings, contactHeight: h }).runToEnd().touchedTape) touched = h;
    }
    assert.ok(touched !== null);
    assert.equal(predictFloat({ ...tapeSettings, contactHeight: touched }).drift, null);
});

test('difficulty rewards knuckle drift', () => {
    const result = serve({}).runToEnd();
    assert.ok(difficultyScore({ ...result, drift: 0.5 }) > difficultyScore({ ...result, drift: 0 }));
});

test('panel orientation shifts the drag crisis of a float, not of a spinning ball', () => {
    const settings = { ...BASE, ...SERVE_PRESETS.float.male, knuckleStrength: 0 };
    const landings = new Set();
    for (let seed = 1; seed <= 20; seed++) {
        landings.add(serve({ ...settings, floatSeed: seed }).runToEnd().position.x.toFixed(2));
    }
    assert.ok(landings.size > 5, 'different panel orientations should change the flight distance');

    const noShift = serve({ ...settings, floatSeed: 5, crisisShift: 0 }).runToEnd().position;
    const topspin = { ...settings, spin: 8, floatSeed: 5 };
    const shifted = serve(topspin).runToEnd().position;
    const unshifted = serve({ ...topspin, crisisShift: 0 }).runToEnd().position;
    assert.ok(shifted.distanceTo(unshifted) < 0.01, 'spin averages the panel effect out');
    assert.ok(noShift.y > 0);
});

test('calibration: robot float serve scatter (Hong et al. 2018) is matched', () => {
    // 15 m/s, no spin, ~15 m flight; measured lateral SD 42-72 cm including robot inaccuracy
    const settings = { ...BASE, contactHeight: 2.6, launchSpeed: 15, verticalAngle: 14.25 };
    const lateral = [];
    for (let seed = 1; seed <= 200; seed++) {
        const result = serve({ ...settings, floatSeed: seed }).runToEnd();
        if (!result.touchedTape && !result.classification.startsWith('Net')) lateral.push(result.position.z);
    }
    const mean = lateral.reduce((a, b) => a + b) / lateral.length;
    const sd = Math.sqrt(lateral.reduce((s, z) => s + (z - mean) ** 2, 0) / lateral.length);
    assert.ok(sd > 0.3 && sd < 0.5, `lateral SD ${sd.toFixed(2)} m`);
});
