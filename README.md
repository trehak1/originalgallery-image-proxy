# originalgallery-image-proxy

Pass-through proxy for originalgallery.com that resizes, converts (AVIF/WebP) and caches images. Everything else goes to the origin unchanged, so the application needs no changes.

- **nginx** routes requests, terminates TLS and caches results on disk for 30 days.
- **imgproxy** resizes from the original (800 px on listings, 2048 px elsewhere) and encodes AVIF q55, falling back to WebP or JPEG.
- If imgproxy fails, the original image is served.

On the `/works` page, data per view drops from 26.1 MB to 5.0 MB. The details are in [report.html](report.html) (in Czech).

## Run locally

```sh
./certs/gen.sh          # self-signed cert for originalgallery.com
docker compose up -d    # http://localhost:8080, https on 127.0.0.1:8443
```

Open http://localhost:8080/works. Absolute links to originalgallery.com are rewritten to the host you came in on.

## Deploy

Put the proxy in front of the app and set the environment in `compose.yaml`; the nginx config stays the same:

- `ORIGIN_SCHEME` and `ORIGIN_SERVER` point to the app, e.g. `http` and `127.0.0.1:3000`.
- `PUBLIC_HOST` is `originalgallery.com`.
- `CACHE_SIZE` limits the image cache, `10g` by default.

To clear the cache:

```sh
docker compose exec proxy sh -c 'rm -rf /var/cache/nginx/img/*' && docker compose restart proxy
```

## Benchmark

```sh
cd bench && npm install && node measure.mjs
```

Loads `/works` in headless Chromium at 50 Mbit/s, first directly and then through the proxy with a cold cache and a warm cache. Results are written to `bench/results.json`.
