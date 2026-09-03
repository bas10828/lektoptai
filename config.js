const path = require('path');

for (const required of ['CAM_USER', 'CAM_PASS', 'NOPARKING_CAM_IP', 'INTRUSION_CAM_IPS', 'PORTAL_USERNAME', 'PORTAL_PASSWORD']) {
  if (!process.env[required]) throw new Error(`Missing required env var ${required} (see .env.example)`);
}

const camUser = process.env.CAM_USER;
const camPass = process.env.CAM_PASS;
const camPort = Number(process.env.CAM_PORT || 20443);
const rtspPort = Number(process.env.RTSP_PORT || 554);

const webPort = Number(process.env.WEB_PORT || 8090);

// Front-house — single camera, YOLO-driven vehicle detection. Tuning
// carried over from vehicle-yolo-detector/config.js (settled 2026-08-28,
// see reference_no_parking_yolo_deploy). Zone is pixel-space and does NOT
// travel with a camera swap — must be redrawn against this camera on
// first run (see [[reference_no_parking_yolo_deploy]]).
const noParking = {
  id: 'noparking',
  label: 'ตรวจจับรถจอด (YOLO) - หน้าบ้าน',
  camIp: process.env.NOPARKING_CAM_IP,
  camPort, camUser, camPass, rtspPort,
  rtspPath: 'stream1',
  speakerVolume: 100,
  warningFilesVehicle: ['1_th', '2_en', '3_zh', '4_ja', '5_ko'].map((f) =>
    path.join(__dirname, 'warnings-vehicle', `${f}.alaw`)),
  sirenMs: 2500,
  maxLoopMsToggle: 30 * 60 * 1000,
  pollMs: 3000,
  stableCount: 3,
  iouSameSpotThreshold: 0.5,
  zoneOverlapThreshold: 0.3,
  confidenceThreshold: 0.4,
  vehicleClasses: ['car', 'truck', 'bus', 'motorcycle', 'bicycle'],
  // Temporarily false: zone-settings.json isn't tuned for .52 yet (an
  // untuned fallback zone already fired a real siren+audio warning once
  // this session against this camera). Flip back to true once the zone is
  // redrawn and confirmed on the /no-parking dashboard.
  armedDefault: false,
};

// Back-house — four cameras, camera-native person detection (no YOLO).
// Labels are placeholders until the user assigns real per-camera roles.
const intrusionIps = process.env.INTRUSION_CAM_IPS.split(',').map((s) => s.trim()).filter(Boolean);
const intrusionCams = intrusionIps.map((ip, i) => ({
  id: `intr${i + 1}`,
  label: `กล้อง ${i + 1} (.${ip.split('.').pop()})`,
  camIp: ip,
  camPort, camUser, camPass, rtspPort,
  rtspPath: 'stream1',
  speakerVolume: 100,
  entryEventType: 'MotionDetection_people_enhance',
  heartbeatSec: 15,
  warningFiles: [path.join(__dirname, 'warnings', '1_th.alaw')],
  presenceTimeoutMs: 20000,
  maxLoopMs: 90000,
  sirenMs: 2500,
  // Never triggered live before on these units — armed manually per-camera
  // from the dashboard after a confirmed test, not hot on first boot.
  armedDefault: false,
}));

// Optional — if set, server.js overwrites the placeholder labels above with
// real channel names pulled from the NVR at startup (see nvr-client.js).
const nvr = process.env.NVR_IP ? {
  nvrIp: process.env.NVR_IP,
  nvrPort: Number(process.env.NVR_PORT || 20443),
  nvrUser: process.env.NVR_USER || camUser,
  nvrPass: process.env.NVR_PASS || camPass,
} : null;

module.exports = {
  webPort, noParking, intrusionCams, nvr,
  portalUsername: process.env.PORTAL_USERNAME,
  portalPassword: process.env.PORTAL_PASSWORD,
};
