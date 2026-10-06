# Contributing

Paca is a small single-user tool. Small, focused changes are easiest to review.

## Set up

```sh
git clone https://github.com/mtrenker/paca.git
cd paca
npm ci
npm test
```

Node.js 24 or newer is required. See the [README](README.md) for running Paca itself.

## Make a change

- Keep a change to one purpose, and open or link an issue for anything bigger than a fix.
- Add a focused test for changed behavior, especially anything touching sign-in, sessions,
  repository scope, limits or GitHub writes. Tests live in `test/` and run with `node --test`.
- Use the fakes the tests already use: pi-ai's faux provider for models, a stub `run` function or
  stub `github` object for GitHub, and stub `oidc` and `paca` objects for the server. Tests must
  not call a real model, GitHub or an identity provider.
- Never test against live GitHub writes. A real issue is created only when the person whose
  account it is approves that exact issue in the app.

## Preview a change

Give each checkout its own `.data/` directory and port (see the README), so previews never share
a conversation, a draft record or a port. Stop what you started with Ctrl-C.

## Keep private data out

Never commit `.data/`, secrets, tokens, `.env` files, conversation databases, screenshots of
private issues, or real hostnames, account IDs and secret references. Use placeholders in docs.

## Pull requests

Describe what changed and why, how you checked it (`npm test` and any manual check), and what is
left out. Link the issue with `Refs #<number>`, or `Closes #<number>` only when the pull request
finishes the issue. `npm test` runs on every pull request.

By contributing, you agree that your contributions are released under the [MIT License](LICENSE).
