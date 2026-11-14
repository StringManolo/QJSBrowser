#!/usr/bin/env sh

qjs .testSocketLib.js &

sleep 1

curl http://localhost:8080/test
