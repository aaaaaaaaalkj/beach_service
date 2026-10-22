// Three.js scene: court, net, ball, helpers. No simulation logic.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    COURT_WIDTH, COURT_LENGTH, NET_LENGTH, NET_VISUAL_HEIGHT, NET_BAND_HEIGHT, POLE_HEIGHT,
    POLE_RADIUS, POLE_DISTANCE, ANTENNA_HEIGHT, ANTENNA_RADIUS, BALL_RADIUS,
} from './constants.js';

const UP = new THREE.Vector3(0, 1, 0);

// --- Procedural textures ---

function createAntennaMaterial() {
    const canvas = document.createElement('canvas');
    const canvasSize = 64;
    canvas.width = 1; // Width doesn't matter for horizontal stripes
    canvas.height = canvasSize;
    const ctx = canvas.getContext('2d');

    const bandHeight = canvasSize / 2; // Half canvas for red, half for white
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, bandHeight, canvas.width, bandHeight);
    ctx.fillStyle = '#ff3030';
    ctx.fillRect(0, 0, canvas.width, bandHeight);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping; // Repeat vertically

    return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, metalness: 0.1 });
}

function createNetMaterial({ canvasSize, lineWidth, lineColor }) {
    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext('2d');

    // Background is transparent by default. We just draw the opaque parts (cords).
    const center = canvasSize / 2;
    const drawCross = (offset, color, width) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(0, center + offset); ctx.lineTo(canvasSize, center + offset);
        ctx.moveTo(center + offset, 0); ctx.lineTo(center + offset, canvasSize);
        ctx.stroke();
    };
    drawCross(1, '#555555', lineWidth);         // Shadow (offset down/right)
    drawCross(0, lineColor, lineWidth * 0.8);   // Main cord
    drawCross(-1, '#ffffff', lineWidth * 0.3);  // Highlight (offset up/left)

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;

    return new THREE.MeshStandardMaterial({
        alphaMap: texture, // Cords = opaque, empty = transparent
        color: 0xffffff,
        roughness: 0.8,
        metalness: 0.1,
        transparent: true,
        side: THREE.DoubleSide,
        alphaTest: 0.5, // Discard pixels below this alpha for sharp holes
    });
}

// Arrow made of a cylinder shaft and a cone head along local +Y; scaled along Y for its length
function createArrow(color, shaftRadius, headLengthRatio, headWidthRatio) {
    const headLength = headLengthRatio;
    const shaftLength = 1.0 - headLengthRatio;
    const material = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.6 });

    const shaftGeo = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 16);
    shaftGeo.translate(0, shaftLength / 2, 0); // Origin at its base
    const headGeo = new THREE.ConeGeometry(shaftRadius * headWidthRatio, headLength, 16);
    headGeo.translate(0, headLength / 2, 0);
    const head = new THREE.Mesh(headGeo, material);
    head.position.y = shaftLength;

    const arrow = new THREE.Group();
    arrow.add(new THREE.Mesh(shaftGeo, material), head);
    arrow.visible = false;
    return arrow;
}

// --- Court ---

function createGround(scene) {
    const groundLength = COURT_LENGTH * 1.5;
    const groundWidth = COURT_WIDTH * 2.2;
    const material = new THREE.MeshStandardMaterial({
        color: 0xEEDC82, // Tint applied to the sand texture
        side: THREE.DoubleSide,
        roughness: 1,
        metalness: 0.0,
    });
    material.map = new THREE.TextureLoader().load(
        'sand.jpg',
        (texture) => {
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            texture.repeat.set(groundLength / 2, groundWidth / 2); // Repeat every 2 meters
            texture.colorSpace = THREE.SRGBColorSpace;
            material.needsUpdate = true;
        },
        undefined,
        (err) => console.error('An error happened loading the sand texture:', err)
    );

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(groundLength, groundWidth), material);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Court lines (lines are part of the court: their outer edges are the boundary)
    const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const LINE_HEIGHT = 0.01;
    const LINE_THICKNESS = 0.05;
    const addLine = (width, depth, x, z) => {
        const line = new THREE.Mesh(new THREE.BoxGeometry(width, LINE_HEIGHT, depth), lineMaterial);
        line.position.set(x, LINE_HEIGHT / 2, z);
        line.receiveShadow = true;
        scene.add(line);
    };
    addLine(COURT_LENGTH, LINE_THICKNESS, 0, COURT_WIDTH / 2 - LINE_THICKNESS / 2);  // Sidelines
    addLine(COURT_LENGTH, LINE_THICKNESS, 0, -COURT_WIDTH / 2 + LINE_THICKNESS / 2);
    addLine(LINE_THICKNESS, COURT_WIDTH, -COURT_LENGTH / 2 + LINE_THICKNESS / 2, 0); // Baselines
    addLine(LINE_THICKNESS, COURT_WIDTH, COURT_LENGTH / 2 - LINE_THICKNESS / 2, 0);
    addLine(LINE_THICKNESS, COURT_WIDTH, 0, 0);                                      // Center line
}

// Poles, net, bands, cables and antennas. Returns a function that moves everything to a net height.
function createNet(scene, renderer) {
    const poleGeometry = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 16);
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.6, roughness: 0.5 });
    for (const z of [POLE_DISTANCE / 2, -POLE_DISTANCE / 2]) {
        const pole = new THREE.Mesh(poleGeometry, poleMaterial);
        pole.position.set(0, POLE_HEIGHT / 2, z);
        pole.castShadow = true;
        scene.add(pole);
    }

    // Net mesh, tiled so that each square is 10 cm
    const netMaterial = createNetMaterial({ canvasSize: 128, lineWidth: 20, lineColor: '#dddddd' });
    const netSquareSize = 0.1;
    netMaterial.alphaMap.repeat.set(NET_LENGTH / netSquareSize, NET_VISUAL_HEIGHT / netSquareSize);
    netMaterial.alphaMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const net = new THREE.Mesh(new THREE.PlaneGeometry(NET_LENGTH, NET_VISUAL_HEIGHT), netMaterial);
    net.rotation.y = Math.PI / 2; // Rotate to span Z axis
    scene.add(net);

    // Top and bottom bands
    const bandGeometry = new THREE.PlaneGeometry(NET_LENGTH, NET_BAND_HEIGHT);
    const bandMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xAAAAAA,
        side: THREE.DoubleSide,
        roughness: 0.8,
        metalness: 0.0,
        polygonOffset: true,
        polygonOffsetFactor: -1.0,
        polygonOffsetUnits: -1.0
    });
    const [topBand, bottomBand] = [0, 1].map(() => {
        const band = new THREE.Mesh(bandGeometry, bandMaterial);
        band.rotation.y = Math.PI / 2;
        band.castShadow = true;
        band.receiveShadow = true;
        scene.add(band);
        return band;
    });

    // Cables connecting the bands to the poles
    const cables = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xdddddd }));
    scene.add(cables);

    // Antennas with holders covering them along the net mesh
    const antennaMaterial = createAntennaMaterial();
    const holderMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.7,
        metalness: 0.1,
        polygonOffset: true, // Avoid z-fighting with the antenna
        polygonOffsetFactor: -0.5,
        polygonOffsetUnits: -1.0
    });
    const antennaLength = NET_VISUAL_HEIGHT + ANTENNA_HEIGHT;
    const antennaGeometry = new THREE.CylinderGeometry(ANTENNA_RADIUS, ANTENNA_RADIUS, antennaLength, 16);
    const holderGeometry = new THREE.CylinderGeometry(ANTENNA_RADIUS + 0.002, ANTENNA_RADIUS + 0.002, NET_VISUAL_HEIGHT, 16);
    const patternHeight = 0.20; // One red + one white 10 cm stripe
    antennaMaterial.map.repeat.set(1, antennaLength / patternHeight); // 1.8 m => 9 repeats
    const antennaParts = [COURT_WIDTH / 2, -COURT_WIDTH / 2].map(z => {
        const antenna = new THREE.Mesh(antennaGeometry, antennaMaterial);
        const holder = new THREE.Mesh(holderGeometry, holderMaterial);
        antenna.castShadow = true;
        holder.castShadow = true;
        scene.add(antenna, holder);
        return { antenna, holder, z };
    });

    return function setNetHeight(netHeight) {
        const bottomEdgeY = netHeight - NET_VISUAL_HEIGHT;
        net.position.y = netHeight - NET_VISUAL_HEIGHT / 2;
        topBand.position.y = netHeight - NET_BAND_HEIGHT / 2;
        bottomBand.position.y = bottomEdgeY + NET_BAND_HEIGHT / 2;

        const netEndZ = NET_LENGTH / 2;
        const poleZ = POLE_DISTANCE / 2 - POLE_RADIUS;
        const cablePoints = [];
        for (const y of [topBand.position.y, bottomBand.position.y]) {
            for (const side of [1, -1]) {
                cablePoints.push(new THREE.Vector3(0, y, side * netEndZ), new THREE.Vector3(0, y, side * poleZ));
            }
        }
        cables.geometry.dispose();
        cables.geometry = new THREE.BufferGeometry().setFromPoints(cablePoints);

        // Antennas run from the bottom edge of the net to ANTENNA_HEIGHT above the net
        for (const { antenna, holder, z } of antennaParts) {
            antenna.position.set(0, bottomEdgeY + antennaLength / 2, z);
            holder.position.set(0, netHeight - NET_VISUAL_HEIGHT / 2, z);
        }
    };
}

function createBall(scene) {
    const material = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
    material.map = new THREE.TextureLoader().load(
        'beachvolleyball.png',
        (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            material.needsUpdate = true;
        },
        undefined,
        (err) => console.error('Failed to load volleyball texture:', err)
    );
    const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 32, 32), material);
    ball.castShadow = true;
    scene.add(ball);
    return ball;
}

// --- Public API ---

export function createBeachScene(container) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Sky blue

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 1, 0);
    controls.minDistance = 1.5; // Prevent zooming too close
    controls.maxDistance = COURT_LENGTH * 2.5; // Limit zoom out based on court size
    controls.maxPolarAngle = (90 + 2) * Math.PI / 180; // Allow looking slightly upwards from ground level (92°)
    controls.minPolarAngle = 0.1; // (~6 degrees from pure vertical 'up')

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(15, 25, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.camera.left = -COURT_LENGTH * 1.1;
    sun.shadow.camera.right = COURT_LENGTH * 1.1;
    sun.shadow.camera.top = COURT_WIDTH * 2.5;
    sun.shadow.camera.bottom = -COURT_WIDTH * 2.5;
    scene.add(sun);

    createGround(scene);
    const setNetHeight = createNet(scene, renderer);
    const ball = createBall(scene);

    const serveArrow = createArrow(0xff8888, 0.01, 0.2, 3);
    scene.add(serveArrow);

    const windArrowY = POLE_HEIGHT + 0.4;
    const windArrows = [POLE_DISTANCE / 2 + 0.5, -POLE_DISTANCE / 2 - 0.5].map(z => {
        const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, windArrowY, z), 1, 0x4169E1, 0.5, 0.3);
        scene.add(arrow);
        return arrow;
    });

    let trajectoryLine = null;
    let ghostLine = null;

    // Resize the canvas whenever its container changes size (window resize or panel collapse)
    new ResizeObserver(() => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
    }).observe(container);

    return {
        camera,
        controls,
        setNetHeight,

        setBall(position, orientation) {
            ball.position.copy(position);
            if (orientation) ball.quaternion.copy(orientation);
            else ball.quaternion.identity();
        },

        // Serve arrow: length scales with the launch speed
        showServeArrow(origin, direction, speed) {
            serveArrow.scale.set(1, THREE.MathUtils.clamp(speed / 16, 0.6, 3), 1);
            serveArrow.position.copy(origin);
            serveArrow.quaternion.setFromUnitVectors(UP, direction.clone().normalize());
            serveArrow.visible = true;
        },
        hideServeArrow() {
            serveArrow.visible = false;
        },

        // windVelocity: Vector3 in m/s (zero = no wind)
        setWind(windVelocity) {
            const speed = windVelocity.length();
            const visible = speed > 0;
            for (const arrow of windArrows) {
                arrow.visible = visible;
                if (!visible) continue;
                const length = THREE.MathUtils.clamp(speed * 0.25, 0.5, 2.5);
                arrow.setDirection(windVelocity.clone().normalize());
                arrow.setLength(length, Math.min(0.5, length * 0.4), Math.min(0.3, length * 0.3));
            }
        },

        setTrajectory(points) {
            if (trajectoryLine) {
                scene.remove(trajectoryLine);
                trajectoryLine.geometry.dispose();
                trajectoryLine.material.dispose();
                trajectoryLine = null;
            }
            if (points.length < 2) return;
            trajectoryLine = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(points),
                new THREE.LineBasicMaterial({ color: 0xe60000 })
            );
            scene.add(trajectoryLine);
        },
        // Dashed path of the same serve without the knuckle force
        setGhostTrajectory(points) {
            if (points.length < 2) return;
            ghostLine = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(points),
                new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.15, gapSize: 0.1 })
            );
            ghostLine.computeLineDistances();
            scene.add(ghostLine);
        },
        clearTrajectory() {
            for (const line of [trajectoryLine, ghostLine]) {
                if (!line) continue;
                scene.remove(line);
                line.geometry.dispose();
                line.material.dispose();
            }
            trajectoryLine = null;
            ghostLine = null;
        },

        render() {
            renderer.render(scene, camera);
        },
    };
}
