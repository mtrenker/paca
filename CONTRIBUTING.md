# Contributing

Paca is a small tool for a few configured users. Small, focused changes are easiest to review.

## Set up

```sh
git clone https://github.com/mtrenker/paca.git
cd paca
npm ci
npm run typecheck
npm test
```

Node.js 24 or newer is required. See the [README](README.md) for running Paca itself and
[Architecture](docs/architecture.md) for how the packages fit together.

The packages are TypeScript that Node runs directly by stripping types, so use only erasable
syntax: no enums, namespaces or constructor parameter properties. Only the page is compiled
(`npm run build`).

## Make a change

- Keep a change to one purpose, and open or link an issue for anything bigger than a fix.
- Add a focused test for changed behavior, especially anything touching sign-in, sessions,
  users, repository scope, limits or GitHub writes. Tests live in `packages/*/test/` and run with
  `node --test`.
- Use the fakes the tests already use: pi-ai's faux provider for models, a stub `run` function or
  stub `github` object for GitHub, `test/container/fake-herdr.mjs` for Herdr's socket, and stub
  `oidc` objects and users for the server. Tests must not call a real model, GitHub, Herdr or an
  identity provider, and never prompt a real agent.
- Never test against live GitHub writes. A real issue is created only when the person whose
  account it is approves that exact issue in the app.

## Preview a change

`npm run preview` runs Paca with two synthetic users, `martin` and `alex`, and no real
credentials: a fake OIDC provider and a fake model (from `test/container/fakes.mjs`), and a fake
`gh` that answers issue creation with a made-up issue, so **Create issue** never reaches GitHub.
Reads are not faked and show as unavailable. The fake model drafts one issue in the user's own
repository for every question. `martin` is the operator and also has a fake Herdr with two agents
in scope and one outside it: a question that mentions an agent lists them and proposes a prompt,
and **Send prompt** only records it in the fake (the preview's terminal says so).

```sh
ss -ltn | grep -E ':440[2-4] ' || echo "4402-4404 are free"
PACA_PORT=4402 npm run preview
```

It uses `PACA_PORT` and the next two ports (fake provider and model, fake sign-in page), so give
each checkout its own base port. Data lives in the checkout's `.data/preview/` and is kept across
restarts; delete that directory to start over. Open `http://localhost:<port>/` and pick a user on
the fake sign-in page. That page uses a throwaway certificate, so the browser warns once. Use a
private window for the second user. Stop everything with Ctrl-C.

## Keep private data out

Never commit `.data/`, secrets, tokens, `.env` files, conversation databases, screenshots of
private issues, or real hostnames, account IDs and secret references. Use placeholders in docs.

## Pull requests

Describe what changed and why, how you checked it (`npm test` and any manual check), and what is
left out. Link the issue with `Refs #<number>`, or `Closes #<number>` only when the pull request
finishes the issue. Every pull request runs `npm test` and builds and smoke-tests the container
image ([Test the image](docs/container.md#test-the-image)).

By contributing, you agree that your contributions are released under the [MIT License](LICENSE).
