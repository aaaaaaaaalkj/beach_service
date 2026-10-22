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
- Drag: by default the measured drag curve of the **Mikasa VLS 300** (official FIVB beach ball): Cd ≈ 0.35 at
  10 m/s, falling through the drag crisis (Cd = 0.3 at Re ≈ 186 000, about 11.6 m/s) to a minimum of 0.155 at
  15 m/s and ≈ 0.18 above. Below 10 m/s the curve is extrapolated (assumed 0.45). Other choices under
  "Ball aerodynamics": the indoor Mikasa MVA 200 (measured), a custom drag crisis at an adjustable critical
  speed, or a constant Cd of 0.45. Values were read off Fig. 4 of Dumek & Urban (2018), see sources.
- Knuckling: a float serve gets a side force from how the ball's panels face the airflow. "Ball contact"
  (a seed) sets the panel orientation at contact and a small leftover spin (up to 0.5 rev/s); the same seed
  always gives the same flight. Spin averages the effect out, so topspin serves fly true. The strength
  (default 0.06) matches the order of magnitude measured for a non-spinning VLS 300 (lift and side force
  coefficients of roughly ±0.05-0.1, Dumek & Šafařík 2018); a pure float then deviates by a median of about
  25 cm at the receiver. Only one panel orientation was measured, so the orientation pattern itself is modelled.
- Magnus lift coefficient uses the empirical sphere fit `C_L = 1 / (2 + 1/S)` with spin parameter `S = Rω / v`;
  it gives ≈ 0.3 at S = 0.85, close to the VLS 300 wind tunnel value.
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

## Sources

- J. Dumek, J. Urban: *Measurement of Surface Roughness of Volleyball*. Acta Mechanica Slovaca 22 (2018) 34-37,
  [doi:10.21496/ams.2018.015](https://doi.org/10.21496/ams.2018.015) — drag curves of the VLS 300 and MVA 200 (Fig. 4),
  critical Reynolds numbers (Tab. 2).
- J. Dumek, P. Šafařík: *Complete Description of Forces Acting on a Flying Beach Volleyball*. EPJ Web of Conferences
  180, 02021 (2018), [doi:10.1051/epjconf/201818002021](https://doi.org/10.1051/epjconf/201818002021) — drag, lift and
  side force of the VLS 300 at 10-25 m/s and 0-12.5 rps.
- S. Hong, T. Asai et al.: *Aerodynamic Effects of a Panel Orientation in Volleyball Float Serve*. ISBS 2018 — the
  critical Reynolds number changes with panel orientation.

## Credits

Sand texture "[Smooth sand dunes](https://www.the3rdsequence.com/texturedb/texture/43/smooth+sand+dunes/)" by the3rdSequence, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Resized to 1024×1024 and recompressed.
