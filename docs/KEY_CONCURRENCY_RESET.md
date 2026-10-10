# Emergency API-key concurrency reset

Use `POST /api/keys/{id}/reset-concurrency` only to recover a key whose
process-local concurrency slots remain occupied after its clients have stopped.
`{id}` is the dashboard key record ID, not the API key value. No body is required.

## Authentication and invocation

A valid dashboard JWT in the `auth_token` cookie **or** the existing verified
`x-9r-cli-token` management token is mandatory. This remains true when
`requireLogin=false`: anonymous dashboard access and loopback access do not
permit emergency cleanup. Ordinary API keys (including `Authorization: Bearer`,
`x-api-key`, and `x-goog-api-key`) do not grant management access. No new credential
or configuration is introduced; use the existing dashboard login or CLI-token
mechanism. Never publish management credentials in logs or incident reports.

Prefer a direct connection to the affected instance, rather than a load-balanced
URL. For example, with the existing management token supplied privately:

```sh
curl --request POST \
  --header "x-9r-cli-token: ${CLI_TOKEN:?set the existing management token}" \
  "http://127.0.0.1:20128/api/keys/${KEY_ID:?set the dashboard key ID}/reset-concurrency"
```

An authenticated dashboard session can instead use its `auth_token` cookie.
Unauthenticated or invalid credentials return `401` before looking up the key;
an authenticated request for an unknown key ID returns `404`.

A successful response reports the number of slots cleared:

```json
{"ok":true,"clearedSlots":3,"scope":"process","requestsCancelled":false}
```

`clearedSlots: 0` is also a successful no-op.

## Safety and scope

- Deploy this fix with a **full process restart**, not a cross-version development
  hot reload: old module instances still hold pre-token release callbacks. Ordinary
  hot reloads within the fixed version retain the current request-token leases.
- **Only the receiving process is changed.** State is in memory: this endpoint
  does not broadcast to other workers, containers, or hosts, even when they share
  a database. Target and verify each affected process separately.
- **Real requests are not cancelled.** Pause clients and confirm upstream requests
  are no longer active before clearing slots. Otherwise old requests may continue
  alongside newly admitted requests, temporarily exceeding the configured limit.
- Old responses releasing their pre-reset slots do not release slots acquired by
  new requests. This protects accounting; it does not stop old upstream work.
- This action only clears concurrency slots. It does not clear breaker state,
  change stored policies, erase usage, or reset budget caches/reservations.
- Normal policy saves (`PUT /api/keys/{id}`), single-key reset
  (`POST /api/keys/{id}/reset`), and bulk reset (`POST /api/keys/bulk/reset`) remain
  separate breaker/cache operations and **do not clear concurrency**.

After cleanup, check `/api/keys/status` on the same process using management
credentials, then resume traffic cautiously and investigate the leak's cause.
Repeated emergency resets are not a substitute for fixing request lifecycle
release paths.
