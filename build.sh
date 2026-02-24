#!/bin/sh
# Generate config.js from environment variables (used by Cloudflare Pages build)
cat > config.js <<EOF
window.REMOVEBG_API_BASE = '${REMOVEBG_API_BASE:-}';
window.REMOVEBG_API_KEY = '${REMOVEBG_API_KEY:-}';
EOF
echo "config.js generated with API_BASE=${REMOVEBG_API_BASE:-<not set>}"
