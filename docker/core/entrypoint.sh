#!/bin/sh
set -eu
mkdir -p "$DATA_PATH/models"
cp -R /opt/model-cache/. "$DATA_PATH/models/"
exec node /opt/lifemodel/dist/index.js
