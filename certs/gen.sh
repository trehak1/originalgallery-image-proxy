#!/bin/sh
# Self-signed certificate for local testing only.
cd "$(dirname "$0")"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=originalgallery.com" \
  -addext "subjectAltName=DNS:originalgallery.com,DNS:localhost" \
  -keyout tls.key -out tls.crt
