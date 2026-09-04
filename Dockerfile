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
# --extra-index-url (not --index-url): --index-url restricts ALL packages,
# including transitive deps like typing-extensions, to the PyTorch index
# only — that index has no source-build tooling (flit_core), so a
# typing-extensions version with no prebuilt wheel there fails outright.
# --extra-index-url keeps PyPI as a fallback for everything except torch
# itself, which still resolves to the CPU wheel from the pytorch index.
#
# torchvision MUST be installed here too, pinned to the matching CPU build
# (same as torch) — installing it later as ultralytics' own dependency lets
# pip resolve a torchvision wheel from plain PyPI that doesn't ABI-match a
# CPU-only torch, which fails at inference time with
# "NotImplementedError: Could not run 'torchvision::nms' with arguments
# from the 'CPU' backend". Versions match the working dev-box venv
# (torch 2.13.0+cpu / torchvision 0.28.0+cpu).
RUN pip3 install --break-system-packages --no-cache-dir \
      torch==2.13.0 torchvision==0.28.0 \
      --extra-index-url https://download.pytorch.org/whl/cpu \
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
