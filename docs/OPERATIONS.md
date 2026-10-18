# Organizer operations

The app and the owner's current database are deployed to Cloudflare at https://organizer.property-scraper.workers.dev. The authorized database transfer completed on 19 October 2026. Production Google secrets are installed; the owner must complete sign-in and reconnect both calendars. The owner confirmed saving the CI token; the first hosted pipeline run awaits the owner's push. See the [README](../README.md) for commands and secrets.

## Storage and recovery

Local domain and OAuth data live in `.wrangler/state`. Stop both development processes before copying that directory to a private backup. Restore the entire directory while both processes are stopped, then restart. Keep the encryption key separately. Isolated smoke stores are disposable fixtures. Local and production databases diverge after cutover; development writes do not update production.

The deployment backup is private and ignored by Git: `.wrangler/backups/production-cutover-20261019/database.sqlite` contains the complete consistent local SQLite snapshot; `database.json` contains the 19 domain tables and a SHA-256 checksum. Both files have owner-only permissions. Preserve `.dev.vars` separately because it contains the encryption key. Do not publish any of these files or upload them as CI artifacts.

The one-time transfer used Cloudflare's authenticated SQL administration API against the Durable Object named by the verified owner's Google subject. It preserved records, versions, audit history, receipts, and encrypted Calendar credentials. It excluded Miniflare metadata, transient local OAuth sessions, and derived Calendar range caches. Production uses fresh OAuth sessions and recomputes range caches when synchronizing. No public database administration endpoint was added.

The transfer rehearsals test booking reference cycles, credentials, final reviews, Unicode, private backups, tampering, occupied-target rejection, and object restart between batches. The final source app was stopped before taking the authoritative snapshot. All remote table values matched the snapshot checksum; foreign-key checks returned no failures.

Operator commands (Node 24 LTS or newer):

```sh
node scripts/database-migration.mjs backup SOURCE.sqlite PRIVATE_DIRECTORY
node scripts/deploy-database.mjs import PRIVATE_DIRECTORY/database.json
node scripts/deploy-database.mjs verify PRIVATE_DIRECTORY/database.json
```

Import is for a newly provisioned database while production Google sign-in remains unconfigured. It refuses existing domain records. Each SQL batch commits separately; if a transfer fails, keep sign-in disabled and inspect the partial target against the private backup before recovery. Never clear a populated production database to rerun the import. `verify` compares the exact cutover snapshot and is expected to differ once production writes or Calendar refreshes occur. These commands are never part of CI.

This local stop/copy/restart procedure was exercised successfully during build verification; the restored domain snapshot matched the original.

Cloudflare's [Time Travel storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#time-travel) provides SQLite Durable Object bookmarks/restoration. OAuth grants and sessions live separately in KV; a domain bookmark does not restore them. Keep the encryption key and plan for the KV/domain boundary. No agent tool exposes arbitrary database restoration or token export.

Before release, rehearse restoration with disposable staging data. Confirm saved reviews and receipts survive and alarm work resumes. Record the bookmark and object identity privately. Database restoration cannot undo Google writes; compare stored event IDs with Google before allowing restored work to run. Production restoration remains a release checkpoint.

## Releases

Pull requests run TypeScript, automated tests, the frontend build, and a Worker dry run. Successful pushes to `main` deploy the Worker and assets, then check the deployed authentication boundary and MCP discovery. Configure `CLOUDFLARE_API_TOKEN` in the GitHub `production` environment using a token scoped to this Cloudflare account. Runtime Google credentials and the encryption key remain Cloudflare secrets. Never use the interactive Wrangler OAuth session as a CI credential.

The owner rejected account-wide GitHub authorization and chose to push commits personally, with no additional GitHub access for the agent. Do not request broader GitHub OAuth access for deployment. If the owner's Git client rejects workflow-file pushes, the owner can use SSH or a fine-grained credential restricted to `bine-cadez/organizer` with Contents and Workflows write permissions. Such credentials stay in the owner's Git setup. The workflow itself has only `contents: read` GitHub permissions.

Deployment retains the existing Durable Object and KV bindings. Schema changes need an explicit compatible migration; a code rollback does not restore database state or reverse Google Calendar changes. Inspect GitHub Actions and Cloudflare deployment logs for a failed release before retrying.

## Calendar recovery

- Pending work is durable and ordered per booking. Stable IDs prevent duplicate inserts after ambiguous success.
- Retry failed operations after checking their current version. Create/move/resize can offer guarded Undo; deletion/lifecycle cleanup uses Retry or reconnect.
- Reconnect the correct role in Settings when requested. Missing/stale data is not empty availability.
- Google edits/deletions of observed bookings win. Work and arbitrary external events are never written.
- Revoking an MCP client blocks new calls; it does not cancel already committed calendar work.

## Live release checks

1. Verify owner-only login and rejection of another Google identity on the intended HTTPS origin.
2. Connect separate Personal and Work identities. Check Personal create/move/resize/delete, Work reads, Google-side edits/deletion, reconnect, and restart with pending work.
3. Connect a real MCP client through authorization-code/PKCE OAuth. Verify scope selection, refresh, revocation, and browser/agent parity.
4. Rehearse restoration in staging across the database, KV, encryption key, and Google event state.
5. Review responsive UI and approve the concrete deployment configuration.

Inspect deployed logs with `npm exec wrangler tail`. Never log cookies, authorization headers, authorization codes, Google credentials, or exported private data.
