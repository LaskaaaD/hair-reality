# Hair Reality

Hair Reality helps a person choose a haircut that fits their own hair and face, and helps the stylist understand what the client wants before the visit. It is a B2B2C consultation tool for salons and barbershops, built for the YouCam API Skin AI & eCommerce VTO Hackathon.

- Live demo (free, no sign-up): https://hairreality.qulagroup.pl
- Example salon link: https://hairreality.qulagroup.pl/s/studio-test?name=Studio%20Test&color=%23b4532a

## What it does

1. **Salon link.** A salon creates one link with its own name and colour. The client opens it on a phone: no app, no account.
2. **Four guided photos.** Front, left, right and top of the head. The camera checks the head angle live, on the device (MediaPipe Face Landmarker), and takes each photo automatically once the pose is one the analysis API accepts.
3. **YouCam analysis.** The photos are sent to the YouCam API for hair type, hair density, hair frizziness and face attributes.
4. **Matching algorithm.** The YouCam reading, a second independent reading of the photos by a vision model, and the client's goals feed a scoring step. It scores around fifty hairstyles against curl pattern, density, length, growth direction, hairline, face shape and the time the client wants to spend styling. Each style comes with a plain-language reason.
5. **Try-on.** The client picks up to three styles and sees each one on their own photo with the YouCam hairstyle try-on, before and after.
6. **Compare and brief.** A comparison view lists pros and cons per style (written by a language model from the scored facts). "Send to my stylist" creates a brief link with the photos, hair profile and chosen looks, branded with the salon.

Previews are AI visualisations. They can shift hair colour or proportions, so the interface always shows them next to the original photo.

## YouCam APIs used

| Purpose | Task |
| --- | --- |
| Hair type | `hair-type-detection` |
| Hair density | `hair-density-detection` (from the top-of-head photo) |
| Hair frizziness | `hair-frizziness-detection` |
| Face shape and attributes | `face-attr-analysis` |
| Try-on | hairstyle generator (`hairstyle` task) |

Calls go through a job queue that records every request and its units. A full session costs about 21 YouCam units (analysis 15, three try-ons 2 each). Live try-ons only start after a ranking that the language model actually produced, and spending is capped by environment variables.

## Stack

TypeScript on Node 24, Express 5, React 19 with prerendered shells (esbuild), PostgreSQL 17, Zod, sharp, MediaPipe Tasks Vision (self-hosted WASM and model under `public/demo-media/mediapipe`), Docker Compose and Caddy for deployment.

```
src/client    React app, guided camera, flow screens
src/server    Express API, job queue, provider clients (YouCam, OpenAI), ranking
src/domain    Scoring and catalogue logic
data/styles   Haircut and beard catalogue
migrations    SQL migrations
```

## Run locally

Requirements: Node.js 24.19 (see `.nvmrc`) and PostgreSQL 17 (a Compose file is included).

```sh
npm ci
cp .env.example .env              # edit: set POSTGRES_PASSWORD, the DATABASE_URL password and SESSION_SECRET
docker compose up -d db           # Postgres on 127.0.0.1:5434
npm run db:migrate
npm run db:seed
npm run dev                       # http://localhost:3000
```

`PROVIDER_MODE=fixture` (the default in `.env.example`) runs the whole flow with recorded fixtures and makes no real YouCam or OpenAI calls. To use the real APIs set `PROVIDER_MODE=live`, `YOUCAM_API_KEY`, `YOUCAM_LIVE_SUBMISSION=1`, `OPENAI_API_KEY`, `OPENAI_LIVE_SUBMISSION=1` and `PROVIDER_DOWNLOAD_ALLOWLIST` as described in `.env.example`. Keys belong in `.env`, which is git-ignored.

## Tests

```sh
npm run typecheck
npm run lint
npm run test:unit          # no database needed
npm run test:integration   # needs the Postgres from docker-compose and TEST_DATABASE_URL
npm run build
```

Tests never call YouCam or OpenAI; they use fixtures and mocks.

## Deploy

`docker-compose.production.yml` runs the app, the database and Caddy (automatic HTTPS). Copy `.env.production.example` to `.env.production`, fill in the domain, secrets and keys, then:

```sh
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

## Privacy

Client photos are stored privately on the server for up to 7 days, only to build the analysis, previews and the stylist brief. A brief link shows them to whoever receives the link until it expires. Expired sessions are purged daily (`npm run demo:purge`).
