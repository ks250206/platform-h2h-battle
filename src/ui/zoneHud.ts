import { CAMERA_FORWARD, CAMERA_RIGHT } from "../game/coordinates";
import type { SafeZone } from "../game/safeZone";
import type { Vec2 } from "../game/types";

export function zoneStatus(zone: SafeZone): string {
  if (!zone.active) return "";
  if (zone.motion === "warning") return `◎ 移動まで ${Math.ceil(zone.startsIn)}秒 · 破線の円へ`;
  if (zone.motion === "travel") return "◎ 移動中 · 破線の円へ";
  return "◎ 安全地帯";
}

// Screen-relative walking directions use the same basis as the controls in both camera modes.
function bearing(from: Vec2, to: Vec2): string {
  const x = to.x - from.x;
  const z = to.z - from.z;
  if (Math.hypot(x, z) < 0.3) return "◎";
  const right = x * CAMERA_RIGHT.x + z * CAMERA_RIGHT.z;
  const up = x * CAMERA_FORWARD.x + z * CAMERA_FORWARD.z;
  return "↑↗→↘↓↙←↖"[(Math.round(Math.atan2(right, up) / (Math.PI / 4)) + 8) % 8];
}

export function zoneDirections(zone: SafeZone, from: Vec2): string {
  if (!zone.active) return "";
  const current = `円 ${bearing(from, zone)}`;
  return zone.destination ? `${current}　次 ${bearing(from, zone.destination)}` : current;
}
