#!/bin/bash
cd "$(dirname "$0")"
echo "Starting removebg frontend on http://localhost:3000"
python3 -m http.server 3000
