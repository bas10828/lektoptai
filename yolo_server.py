"""
Long-lived YOLO inference worker. Loads the model ONCE (loading weights
takes a few seconds — reloading per-poll would be wasteful given we only
need one inference every few seconds, not real-time video FPS), then reads
one image path per line from stdin and writes one JSON result per line to
stdout. Node (yolo-detector.js) talks to this over stdin/stdout the same
way it already shells out to ffmpeg elsewhere in this codebase.

Protocol: request = a single line, the image file path.
          response = a single line of JSON: {"detections": [{"cls": "car", "conf": 0.87, "box": [x1,y1,x2,y2]}, ...]}
          or {"error": "..."} on failure for that one image (worker keeps running).
"""
import sys
import os
import json
from ultralytics import YOLO

# Set from config.js's vehicleClasses/confidenceThreshold via env vars (see
# yolo-detector.js's startYoloWorker) so config.js stays the single source
# of truth instead of duplicating the list here.
VEHICLE_CLASSES = set(os.environ.get("VEHICLE_CLASSES", "car,truck,bus").split(","))
CONFIDENCE_THRESHOLD = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.4"))

def main():
    # "n" (nano) misclassified a parked scooter as "bench"/"truck" from this
    # camera's elevated angle (confirmed live 2026-08-28); "m" (medium)
    # correctly reads it as "motorcycle" at 0.80 conf. Still only one
    # inference per poll (every few seconds), so the extra CPU cost is fine.
    model = YOLO("yolov8m.pt")
    print("READY", file=sys.stderr, flush=True)

    for line in sys.stdin:
        image_path = line.strip()
        if not image_path:
            continue
        try:
            results = model.predict(image_path, verbose=False, conf=CONFIDENCE_THRESHOLD)
            detections = []
            for r in results:
                for box in r.boxes:
                    cls_name = model.names[int(box.cls[0])]
                    if cls_name not in VEHICLE_CLASSES:
                        continue
                    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0]]
                    detections.append({
                        "cls": cls_name,
                        "conf": float(box.conf[0]),
                        "box": [x1, y1, x2, y2],
                    })
            print(json.dumps({"detections": detections}), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)

if __name__ == "__main__":
    main()
