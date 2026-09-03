FROM node:20-bookworm-slim

# ffmpeg — camera preview transcoding (video-stream.js).
# python3/pip — runs yolo_server.py, spawned as a child process by
# yolo-detector.js (no venv; the container itself is the isolated env).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# CPU-only torch explicitly — ultralytics' default install pulls the CUDA
# wheel, which is both dead weight and ~2GB heavier on this GPU-less host.
# --break-system-packages: Debian's system pip refuses global installs
# (PEP 668) otherwise; fine here since the container has no other Python use.
RUN pip3 install --break-system-packages --no-cache-dir \
      torch --index-url https://download.pytorch.org/whl/cpu \
    && pip3 install --break-system-packages --no-cache-dir ultralytics

# Source is bind-mounted at runtime (see docker-compose.yml), not copied —
# there are zero npm dependencies (grep confirms every require() is a Node
# builtin or a local ../file), so there's nothing to install from source,
# and mounting the repo directly means armed-state.json, mode-state.json,
# .session-secret, the event logs, and the auto-downloaded yolov8m.pt all
# persist on the host automatically across container recreates/rebuilds —
# same as they already do on the Windows dev box.
WORKDIR /app
EXPOSE 8090
CMD ["node", "server.js"]
