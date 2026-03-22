#!/bin/bash
docker build . -t shellimage:latest \
 --build-arg USER_ID="$UID" \
 --build-arg USER_NAME="$USER" \
 --build-arg GROUP_ID="$(id -g)" \
 --build-arg GROUP_NAME="$(id -gn)" \
 --build-arg HOME_DIR="$HOME"