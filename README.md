# Beach Volleyball Serve Simulation

Interactive 3D simulation of a beach volleyball serve, built with [Three.js](https://threejs.org/) (r160).

**Live:** https://aaaaaaaaalkj.github.io/beach_service/

## Features

- FIVB court geometry: 16 × 8 m court, net heights for men (2.43 m) and women (2.24 m), antennas, poles
- Configurable serve: launch position, contact height, speed, vertical/horizontal angle, top/back spin
- Float serves: drag crisis (late drop) and knuckling (wobble), reproducible per "ball contact" seed
- Presets for float, jump float and topspin jump serves (men and women)
- After a float, a dashed line shows the path without knuckling; "Knuckle Drift" is the largest distance between the two
- Physics with gravity, quadratic air drag, Magnus force (spin) and wind as moving air
- Net tape contact (ball can bounce back or roll over), net, antenna and crossing-space faults
- Result classification, landing/impact speed, flight time and a difficulty score (speed, reaction time, distance from the receivers, knuckle drift)
- Camera presets, orbit controls and a "ball's eye" camera
- 5 save slots (stored in the browser's `localStorage`), including the camera position

## Running locally

The page loads its textures with `fetch`, which browsers block for `file://` URLs, so serve the folder over HTTP:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

An internet connection is required: Three.js is loaded from unpkg (pinned to 0.160.0, with subresource integrity hashes in the import map).

## Physics notes

- Coordinates: +X towards the net / opponent, +Y up, +Z to the server's right. The net is in the plane x = 0.
- The simulation uses a fixed 1 ms time step, so results do not depend on the display's frame rate.
- Drag crisis: the drag coefficient depends on the Reynolds number, about 0.5 below and 0.2 above a critical
  speed (default 17 m/s, adjustable under "Ball aerodynamics"; it depends on the ball's surface). These are
  estimates for a volleyball, not measurements of a beach ball. With the drag crisis off, Cd is a constant 0.45.
- Knuckling: a float serve gets a side force from how the ball's panels face the airflow. "Ball contact"
  (a seed) sets the panel orientation at contact and a small leftover spin (up to 0.5 rev/s); the same seed
  always gives the same flight. Spin averages the effect out, so topspin serves fly true. The strength
  (default 0.06) is an estimate: a pure float then deviates by a median of about 20 cm at the receiver.
- Magnus lift coefficient uses the empirical sphere fit `C_L = 1 / (2 + 1/S)` with spin parameter `S = Rω / v`.
- A ball is **in** when its contact point touches the court, lines included.
- The ball must cross the net between the antennas (and their imaginary extension upwards) and above the net.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Page markup and import map |
| `css/style.css` | Styles |
| `js/constants.js` | Court, ball and environment constants |
| `js/physics.js` | Ball flight, collisions, line calls and scoring (no DOM, testable in Node) |
| `js/scene.js` | Three.js scene: court, net, ball, arrows, trajectory |
| `js/main.js` | UI, serve flow (phases), cameras, save slots |
| `test/` | Physics tests |
| `sand.jpg` | Sand texture (see credits) |
| `beachvolleyball.png` | Equirectangular ball texture |
| `prototypes/` | Earlier experiments: ball texture generators, serve success plot, first simulation version |

## Tests

The physics runs without a browser, so it is tested with Node's built-in test runner:

```sh
npm install   # installs three.js for Node (dev only)
npm test
```

## Credits

Sand texture "[Smooth sand dunes](https://www.the3rdsequence.com/texturedb/texture/43/smooth+sand+dunes/)" by the3rdSequence, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Resized to 1024×1024 and recompressed.
