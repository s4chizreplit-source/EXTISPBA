#!/usr/bin/env bash
set -euo pipefail

export CI=1

echo "[post-merge] Reconciling Node dependencies..."
npm install --no-audit --no-fund

echo "[post-merge] Applying pending database migrations..."
node server/src/migrate.js

echo "[post-merge] Building application..."
npm run build

echo "[post-merge] Setup complete."