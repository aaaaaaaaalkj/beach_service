// Shared geometry and physical constants.
// Coordinates: +X towards the net / opponent, +Y up, +Z to the server's right. The net is in the plane x = 0.

// Court (FIVB beach volleyball)
export const COURT_WIDTH = 8; // meters
export const COURT_LENGTH = 16; // meters
export const NET_HEIGHT_MEN = 2.43;
export const NET_HEIGHT_WOMEN = 2.24;
export const NET_LENGTH = 8.5;
export const NET_VISUAL_HEIGHT = 1.0; // Height of the net mesh itself
export const NET_BAND_HEIGHT = 0.07;  // Height of the top/bottom white bands
export const POLE_HEIGHT = 3.0;
export const POLE_RADIUS = 0.05;
export const POLE_OFFSET = 0.8; // Distance of the poles from the sidelines (FIVB: 0.70 - 1.00 m)
export const POLE_DISTANCE = COURT_WIDTH + 2 * POLE_OFFSET;
export const ANTENNA_HEIGHT = 0.8; // Above net top band
export const ANTENNA_RADIUS = 0.005; // 10 mm diameter

// Ball
export const BALL_RADIUS = 0.1083; // FIVB beach ball circumference 66-68 cm
export const BALL_MASS = 0.27; // kg (average)
export const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS; // Cross-sectional area

// Environment
export const GRAVITY = 9.81; // m/s^2
export const AIR_DENSITY = 1.225; // kg/m^3

// Server
export const CONTACT_HEIGHT_MEN = 2.2;   // Default ball center height at contact
export const CONTACT_HEIGHT_WOMEN = 2.0;
export const SERVE_DISTANCE_BEHIND_BASELINE = 0.8;
export const CORNER_INSET = 0.5; // Corner serve position, distance inside the sideline
