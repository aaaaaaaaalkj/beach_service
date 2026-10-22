import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ServeSimulation, createServe, classifyLanding, difficultyScore, netHeightFor } from '../js/physics.js';
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
