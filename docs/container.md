# Run Paca in a container

The image `ghcr.io/mtrenker/paca` contains Node 24, `gh`, the pi-clean collector and Paca. It
runs as the non-root `node` user (uid 1000). Configuration, credentials and data come in at
runtime: the image holds no config, token, key or conversation.

The image is built for **linux/amd64 only**. It has been tested with Docker 29 on an x86_64 Linux
host and in GitHub Actions. No other platform is built or tested.

Tags:

- `sha-<full commit>`: one per commit on `main`; never moved. Use this to run Paca.
- `latest`: the most recent commit on `main`.

## What you need

- Docker on the host.
- An HTTPS reverse proxy that serves your `publicUrl`, for example `tailscale serve`. Paca's
  session cookies are `Secure`, so sign-in does not work over plain HTTP.
- An OIDC client for Paca, as in the [README](../README.md#configure), with the redirect URI
  `<publicUrl>/auth/callback`.
- A GitHub token for `GH_TOKEN`: a classic token with `repo` and `read:project` (see
  [Prerequisites](../README.md#prerequisites)). `gh` in the container talks to github.com.
- A credential for one Pi model provider (see [Model credentials](#model-credentials)).

## Prepare the data volume

Everything Paca and Pi write lives in `/data`:

| Path | What it is |
| --- | --- |
| `/data/config.json` | your configuration |
| `/data/paca.sqlite` | the conversation and every issue draft with its outcome |
| `/data/session.key` | the key that signs session cookies, created on first start |
| `/data/pi/` | Pi's agent directory (`PI_CODING_AGENT_DIR`): `auth.json`, `models.json`, `settings.json` |
| `/data/github-workflow.json`, `/data/models-store.json` | generated caches |

Use a named volume. Docker creates it owned by `node` with mode 0700. If you bind-mount a host
directory instead, it must be owned by uid 1000 (`chown 1000:1000 <dir> && chmod 700 <dir>`).
Never mount your home directory, `~/.pi/agent`, `~/.config/gh` or the Docker socket.

1. Write `config.json` as in the [README](../README.md#configure), with two differences:

   - `"piClean": "/opt/pi-clean"`, where the image keeps the collector;
   - `port` is ignored: the container always listens on 4302 (`PACA_PORT`).

2. Copy it into a new volume:

   ```sh
   docker volume create paca-data
   docker run --rm -i -v paca-data:/data --entrypoint sh ghcr.io/mtrenker/paca:<tag> \
     -c 'umask 077 && cat > /data/config.json' < config.json
   ```

   Then delete the local copy if it holds anything private.

### Model credentials

Paca uses Pi's credentials from `/data/pi`. Choose one:

- **An API key** in the provider's environment variable, for example `-e ANTHROPIC_API_KEY`.
  Nothing is written to the volume.
- **An endpoint in `models.json`**, such as llama.cpp or another OpenAI-compatible server. Copy
  the file to `/data/pi/models.json` the same way as `config.json`. The smoke test uses this way.
- **A subscription login** (`/login` in `pi`). Pi stores it in `auth.json` and refreshes it
  there, which is why `/data/pi` must be writable. Copy an `auth.json` made by `pi` to
  `/data/pi/auth.json`. This has not been tested in the container. If you copy your own login,
  the host and the container then share one refresh token, so prefer a login made only for Paca.

Without `model` in `config.json`, Paca uses the default model in `/data/pi/settings.json`.

## Start

Pass secrets as environment variables at start; Docker reads each `-e NAME` without a value
from the environment of `docker run`. With Proton Pass, `.data/secrets.env` holds references
such as `PACA_OIDC_CLIENT_SECRET="pass://<vault>/<item>/<field>"` and
`GH_TOKEN="pass://<vault>/<item>/<field>"`:

```sh
pass-cli run --env-file .data/secrets.env -- \
  docker run -d --name paca --restart unless-stopped \
    -p 127.0.0.1:4302:4302 \
    -v paca-data:/data \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -e PACA_OIDC_CLIENT_SECRET -e GH_TOKEN \
    ghcr.io/mtrenker/paca:sha-<commit>
```

Without Proton Pass, export the variables in the shell first, or use `--env-file` with a file of
mode 0600. Docker stores the values in the container's configuration, where `docker inspect`
shows them to anyone who can use Docker on that host.

Keep the port mapping on `127.0.0.1` and put the HTTPS proxy in front:

```sh
tailscale serve --https=8443 http://127.0.0.1:4302
```

Paca trusts no proxy headers. It checks the browser's `Origin` against `publicUrl`, so the
proxy must pass it unchanged, and it must not buffer the `/api/events` stream.

Check that it started:

```sh
docker logs paca                      # paca: listening on http://0.0.0.0:4302, public at <publicUrl>
curl -fsS http://127.0.0.1:4302/healthz   # ok
docker ps --filter name=paca          # STATUS shows (healthy) after about 30 seconds
```

To pin your account, follow step 3 of [Configure](../README.md#configure). The refused sign-in
appears in `docker logs paca`. Edit `/data/config.json` with the copy command above, then
`docker restart paca`.

## Stop

```sh
docker stop paca    # SIGTERM; Paca exits within 3 seconds
docker rm paca      # the volume and its data stay
```

## Back up

The volume holds secrets (`session.key`, possibly `pi/auth.json`), so keep backups private. Stop
Paca first so the SQLite file is consistent:

```sh
docker stop paca
umask 077
docker run --rm -v paca-data:/data:ro --entrypoint tar ghcr.io/mtrenker/paca:<tag> \
  -czf - -C /data . > paca-data-$(date +%F).tar.gz
docker start paca
```

To restore into an empty volume:

```sh
docker run --rm -i -v paca-data:/data --entrypoint tar ghcr.io/mtrenker/paca:<tag> \
  -xzf - -C /data < paca-data-<date>.tar.gz
```

## Upgrade

1. Back up as above.
2. `docker pull ghcr.io/mtrenker/paca:sha-<new commit>`
3. `docker stop paca && docker rm paca`
4. Start again with the new tag and the same volume.

The session key, conversation and drafts carry over. Paca makes no promise that an older image
can open data a newer one wrote, so to roll back, restore the backup from step 1 and start the
old tag. A reset works as in the [README](../README.md#stop-and-reset): delete
`/data/paca.sqlite` while Paca is stopped, after checking every draft whose outcome is unknown.

## Test the image

```sh
docker build -t paca:smoke .
npm run test:container -- paca:smoke
```

This needs Docker, `openssl` and Node 24 on the host. The test starts the image the way
[Start](#start) does, next to a fake OIDC provider and a fake OpenAI-compatible model with a
throwaway certificate and data. It checks:

- the container runs as uid 1000 and the image's health check passes;
- without a session, `/` redirects to sign-in and the chat and draft endpoints answer 401;
- another subject is refused, the allowed one signs in;
- a wrong `Origin` or CSRF token is refused;
- a question gets an answer with one proposed draft;
- `docker stop` exits 0 within the grace period, and the secrets never appear in the logs;
- a new container on the same volume keeps the session key, the conversation and the draft.

It does not call GitHub: the fake model only drafts, and nobody approves the draft. The test
network is an ordinary Docker bridge, because Docker does not publish ports from internal
networks, but every endpoint is a fake and every credential a dummy. The test removes every
container, network and volume it created (all named `paca-smoke-<run id>`).

Continuous integration runs `npm test` and this test on every pull request and every push to
`main`, and publishes only from `main`.

## Publishing

On `main`, the `publish` job in `.github/workflows/ci.yml` pushes `sha-<commit>` and `latest`
with `GITHUB_TOKEN`, after `test` and `image` pass. Pull request jobs have a read-only token and
never log in to the registry. The job summary shows the pushed digest.

GitHub creates a new package as private, even for a public repository. To make it public once,
someone with admin rights on the package opens
`https://github.com/users/mtrenker/packages/container/paca/settings`, chooses **Change
visibility** under **Danger Zone**, and selects **Public**. Check an anonymous pull with an
empty Docker configuration:

```sh
docker --config "$(mktemp -d)" pull ghcr.io/mtrenker/paca:latest
```

## Design choices

- **Base image:** `node:24.21.0-trixie-slim`, pinned by digest. Node 24 is what Paca requires.
  Debian slim has the glibc that `gh` and Pi's dependencies expect.
- **Downloads:** `gh` 2.102.0, `tini` 0.19.0 and the collector are downloaded at build time and
  checked with `sha256sum` against sums in the Dockerfile. `ADD --checksum` is not used, because
  Docker's legacy builder ignores it. `ca-certificates` comes from Debian without a pinned
  version.
- **pi-clean:** only `scripts/github-planning.mjs` and `scripts/github-planning/lib.mjs`, from
  the full revision `8921989468496a21b2ad19acfaa6198fa949a86e` of the public
  [mtrenker/pi-clean](https://github.com/mtrenker/pi-clean). They use Node built-ins and `gh`
  only. pi-clean has no `LICENSE` file; its `package.json` declares MIT and is copied unchanged
  to `/opt/pi-clean/package.json`. To move to another revision, change `PI_CLEAN_REVISION` and
  the three sums.
- **Third-party notices:** `gh` and `tini` are MIT. Their upstream `LICENSE` files are in
  `/usr/share/licenses/gh/` (from the `gh` release archive) and `/usr/share/licenses/tini/`
  (from the commit of tini's `v0.19.0` tag, checksum-pinned). Paca's own `LICENSE` is in `/app`.
- **npm:** `npm ci --omit=dev --ignore-scripts`. The skipped install scripts are esbuild's and
  protobufjs's postinstall and a no-op in `@google/genai`. `npm test` and the smoke test pass
  without them.
- **Binding:** the image sets `PACA_HOST=0.0.0.0` and `PACA_PORT=4302` so a port mapping can
  reach Paca. Without `PACA_HOST`, Paca still binds to `127.0.0.1`. Sign-in, the `Origin` and
  CSRF checks and draft approval are unchanged, and the container adds no route; the health
  check uses the existing `/healthz`, which answers `ok` and nothing else.
- **One volume:** config, SQLite, session key and Pi's directory share `/data`, so one volume is
  the whole state to back up. The session key must survive a new container, or every session
  ends. Pi's directory must be writable for OAuth refreshes.
- **Init:** `tini` is PID 1. It forwards `SIGTERM` to Node and reaps `gh` processes left behind
  when a collector run times out.
- **Build context:** `.dockerignore` is an allowlist: `package.json`, `package-lock.json`,
  `LICENSE`, and the `src/` and `public/` directories. `.data/`, `.env` files, `.git`,
  `node_modules`, `test/`, `docs/` and other top-level files stay out. Everything inside `src/`
  and `public/` is included, tracked or not, so keep private files out of those directories.
- **One platform:** linux/amd64 only. Adding arm64 would mean per-architecture `gh` and `tini`
  sums and a test on that platform.
- **Publishing:** the `publish` job builds again from the same commit with the build cache the
  `image` job filled. It does not copy the tested image across jobs.
