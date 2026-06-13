# Contributing

## Branches & releases

- Feature/fix branches → PR against `develop`. Merging `develop` builds and
  publishes the `:beta` image (deployed to the staging environment by CI).
- `develop` → `main` release PRs are created automatically (`auto-release-pr.yaml`)
  and merged by a human only after staging is verified. Merging `main` builds and
  publishes the `:latest` image (deployed to production).
- Never push directly to `main`.

## Before pushing

```bash
npm run format:check
npm run type-check
npm run lint
```

## Secrets vs. configuration

- **Secrets** (`TELEGRAM_BOT_TOKEN`, `PGPASSWORD`) → `.env`, never committed.
  `.env.example` carries `CHANGE_ME` placeholders only.
- **Non-secret config** → the deployment's `environment:` block. Values identical
  across environments → defaults in `src/config`.

## CI secrets

CI needs Docker registry credentials and the SSH deploy values for each
environment (see the workflow files under `.github/workflows/`).
