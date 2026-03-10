# Release 0.1.2

Prepared release notes and a publish checklist for the `0.1.2` Nightgate release.

## Suggested GitHub Or npm Release Notes

`0.1.2` makes `@odatano/nightgate` Preprod-ready for public Midnight usage.

- adds first-class `preprod` network support to the Nightgate runtime and plugin config
- adds consistent `NIGHTGATE_*` and `MIDNIGHT_*` environment overrides for the network, node URL, and crawler node URL
- switches the repository defaults to the hosted Midnight Preprod RPC at `wss://rpc.preprod.midnight.network/`
- adds `.env.example` for the recommended Preprod startup path
- clarifies that the bundled Docker Compose file remains local standalone only
- documents the SQLite reset step required when switching an existing workspace between networks

## Suggested Short Summary

```text
0.1.2 makes Nightgate preprod-ready for public Midnight usage. It adds first-class preprod support, runtime environment overrides for network and node URLs, switches the repository defaults to the hosted Preprod RPC, and updates the docs for a preprod-first workflow.
```

## Publish Checklist

1. Review the working tree and confirm only the intended release-prep files are included.
2. Confirm [package.json](../package.json) is set to `0.1.2`.
3. Confirm [CHANGELOG.md](../CHANGELOG.md) has the `0.1.2` section and matches the intended release scope.
4. Run `npm run typecheck`.
5. Run `npm test`.
6. Run `npm run build:plugin`.
7. Optionally run `npm pack --dry-run` to inspect the publish payload before publishing.
8. Publish with `npm publish --access public`.
9. Create the GitHub release using the notes above.

## Notes

- `prepublishOnly` already runs `npm run typecheck && npm test && npm run build:plugin`, but running them explicitly before `npm publish` keeps failures earlier and easier to inspect.
- For local standalone verification after the Preprod-default switch, set `NIGHTGATE_NETWORK=testnet` and `NIGHTGATE_NODE_URL=ws://localhost:9944` in a repo-root `.env` before starting the app.