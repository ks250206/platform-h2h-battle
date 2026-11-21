import type { Vec2 } from "./types";

/**
 * The fixed oblique look-down camera, shared by the renderer and the input mapping so the
 * two can never disagree about which way is "up" on screen. The camera sits above the
 * +X/+Z corner of the arena; the renderer multiplies this offset by a viewport-dependent scale.
 */
export const CAMERA_OFFSET = { x: 18, y: 24, z: 24 } as const;

const groundDistance = Math.hypot(CAMERA_OFFSET.x, CAMERA_OFFSET.z);

/** Unit ground vector pointing away from the camera: screen up. */
export const CAMERA_FORWARD: Vec2 = {
  x: -CAMERA_OFFSET.x / groundDistance,
  z: -CAMERA_OFFSET.z / groundDistance,
};

/** Unit ground vector pointing to the camera's right: screen right. */
export const CAMERA_RIGHT: Vec2 = { x: -CAMERA_FORWARD.z, z: CAMERA_FORWARD.x };

/**
 * Converts a screen-space direction (screen up has negative screenY, as in DOM and gamepad
 * axes) into a world-space ground direction of the same length.
 */
export function screenToWorldMovement(screenX: number, screenY: number): Vec2 {
  return {
    x: screenX * CAMERA_RIGHT.x - screenY * CAMERA_FORWARD.x,
    z: screenX * CAMERA_RIGHT.z - screenY * CAMERA_FORWARD.z,
  };
}
