# HealthAge report cloud storage and synchronization

Status: implemented in backend source. This migration and these routes have not been executed or runtime-verified.

## Stored client data

The backend shape is based on the current mobile repositories, not a reduced report model.

| Existing local field | Cloud field | Notes |
| --- | --- | --- |
| `reports.id` | `id` | Stable client-generated ID; scoped to the authenticated account. |
| `reports.user_id` | not accepted | Ownership always comes from the verified JWT subject. |
| `reports.user_name` | `userName` | Preserved for historical display/export. |
| `reports.user_email` | `userEmail` | Preserved when present. |
| `reports.title` | `title` | Preserved. |
| `reports.answers` | `answers` | Parse the local JSON string and send the array. |
| `reports.report_data` | `reportData` | Parse the local JSON string and send the complete object. This contains the current `HealthMetrics` fields. |
| `reports.date` | `date` | `YYYY-MM-DD`. |
| `reports.created_at` | `createdAt` | Send as an ISO-8601 timestamp with an offset. |
| `groups.id` | `id` | Stable client-generated ID. |
| `groups.owner_id` | not accepted | Ownership comes from the JWT. |
| `groups.name` | `name` | Preserved. |
| `groups.description` | `description` | Preserved. |
| `groups.created_at` | `createdAt` | ISO-8601 timestamp. |
| `report_groups` | relationship mutations | Each `(report_id, group_id)` is independently versioned and tombstoned. |

`reportData` is stored as JSONB without stripping unknown fields, so the current metrics (`name`, height/weight values and units, age/health age/potential age, gender, glucose values and unit, fasting state, and blood pressure values) can be reconstructed in full.

## Authentication and ownership

Every endpoint below requires `Authorization: Bearer <JWT>` and runs the existing `app.authenticate` guard. The only owner ID used by the storage service is `req.authUser.sub`.

All reads include `user_id = authenticatedUserId`. All writes repeat that ownership predicate inside their transaction. Relationship writes load both active parents inside the transaction, and PostgreSQL composite foreign keys `(user_id, report_id)` and `(user_id, group_id)` make cross-account links structurally impossible. A missing, deleted, or foreign record is returned as `404` without exposing its contents.

The routes have request size limits and route-specific rate limits. Report bodies are limited to 512 KiB; sync batches are limited to 2 MiB and 100 mutations. Report content is not written to ordinary application logs or idempotency receipts.

## REST endpoints

All paths are under `/api/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/reports` | Create a report. |
| `GET` | `/reports?limit=25&cursor=...` | Keyset-paginated active report history. |
| `GET` | `/reports/:id` | Get one active owned report and its active `groupIds`. |
| `PATCH` | `/reports/:id` | Update with `expectedVersion`. |
| `DELETE` | `/reports/:id` | Soft-delete with `expectedVersion`; relationship tombstones are created too. |
| `POST` | `/report-groups` | Create a group. |
| `GET` | `/report-groups?limit=25&cursor=...` | Keyset-paginated active groups. |
| `GET` | `/report-groups/:id` | Get one active owned group and its active `reportIds`. |
| `PATCH` | `/report-groups/:id` | Update with `expectedVersion`. |
| `DELETE` | `/report-groups/:id` | Soft-delete with `expectedVersion`; relationship tombstones are created too. |
| `PUT` | `/report-groups/:id/reports` | Add or restore a report/group relationship. |
| `DELETE` | `/report-groups/:id/reports/:reportId` | Tombstone a relationship. |
| `POST` | `/report-sync/mutations` | Atomically upload up to 100 ordered, idempotent mutations. |
| `GET` | `/report-sync/changes?cursor=0&limit=100` | Initial or incremental download, including relationship changes and tombstones. |

### Create report example

```http
POST /api/v1/reports
Authorization: Bearer <token>
Content-Type: application/json

{
  "mutationId": "58bc3f98-5318-4d6c-a5c9-b18446304d18",
  "id": "report_m4rf2z6ax8k1",
  "userName": "Example Person",
  "userEmail": "person@example.com",
  "title": "Health Report",
  "answers": [
    { "questionId": 1, "text": "Example answer", "points": 2 }
  ],
  "reportData": {
    "name": "Example Person",
    "age": "42",
    "healthAge": "39",
    "potentialAge": "35",
    "gender": "female",
    "height": "165 cm",
    "weight": "62 kg",
    "fasting": true,
    "bloodPressureSys": "118",
    "bloodPressureDia": "76",
    "bloodGlucose_mg": "92",
    "selectedGlucoseUnit": "mg/dL",
    "selectedWeightUnit": "kg",
    "selectedHeightUnit": "cm",
    "heightValue": "165",
    "weightValue": "62"
  },
  "date": "2026-11-23",
  "createdAt": "2026-11-23T10:15:30.000+05:30"
}
```

The server deliberately accepts no `userId` or `ownerId` property.

Successful mutation responses contain small synchronization metadata:

```json
{
  "results": [
    {
      "mutationId": "58bc3f98-5318-4d6c-a5c9-b18446304d18",
      "type": "report.create",
      "entityId": "report_m4rf2z6ax8k1",
      "version": 1,
      "changeSequence": "1042",
      "deleted": false,
      "replayed": false
    }
  ]
}
```

Retrying the exact request with the same `mutationId` returns the same result with `replayed: true`. Reusing that UUID for different content returns `409 CONFLICT`.

### Update and delete examples

```json
{
  "mutationId": "2e8f9354-96f4-4ddd-a0e3-d8a571ca90bd",
  "expectedVersion": 1,
  "changes": {
    "title": "Updated title",
    "reportData": { "complete": "current report object" }
  }
}
```

```json
{
  "mutationId": "1be441bb-32ee-4608-81c3-31289dd10a84",
  "expectedVersion": 2
}
```

An update is accepted only when `expectedVersion` exactly matches. A mismatch returns `409` with only `currentVersion` and `deletedAt`; private report content is not included in the error.

### Relationship examples

Add a never-before-created relationship with `expectedVersion: 0`:

```http
PUT /api/v1/report-groups/group_q7a2/reports

{
  "mutationId": "13cf32f5-045f-4a0d-b356-0932bad8270f",
  "reportId": "report_m4rf2z6ax8k1",
  "expectedVersion": 0
}
```

To restore a tombstoned relationship, send its current positive version. To remove an active relationship, send its current version to `DELETE /report-groups/:groupId/reports/:reportId` with the same body shape as a record delete.

## Synchronization protocol

### Upload

`POST /report-sync/mutations` accepts an ordered array of these types:

- `report.create`, `report.update`, `report.delete`
- `group.create`, `group.update`, `group.delete`
- `relationship.put`, `relationship.delete`

Create mutations contain the full create fields. Update mutations contain `id`, `expectedVersion`, and `changes`. Delete mutations contain `id` and `expectedVersion`. Relationship mutations contain `reportId`, `groupId`, and `expectedVersion`.

The complete batch runs in one database transaction and in array order. Send parent creates before relationship creates. If any mutation fails validation, ownership, or version checks, the whole batch rolls back. A retry is therefore safe after a timeout: either all receipts and changes committed, or none did.

```json
{
  "mutations": [
    {
      "type": "group.create",
      "mutationId": "ebcd550d-af34-466d-a4ed-73721c5ea6ef",
      "id": "group_q7a2",
      "name": "Annual checks",
      "description": "",
      "createdAt": "2026-11-23T10:14:00.000+05:30"
    },
    {
      "type": "relationship.put",
      "mutationId": "13cf32f5-045f-4a0d-b356-0932bad8270f",
      "reportId": "report_m4rf2z6ax8k1",
      "groupId": "group_q7a2",
      "expectedVersion": 0
    }
  ]
}
```

### Download

Start a new account/device at cursor `0` and keep requesting until `hasMore` is false:

```http
GET /api/v1/report-sync/changes?cursor=0&limit=100
Authorization: Bearer <token>
```

```json
{
  "changes": [
    {
      "kind": "report",
      "data": {
        "id": "report_m4rf2z6ax8k1",
        "userName": "Example Person",
        "userEmail": "person@example.com",
        "title": "Health Report",
        "answers": [],
        "reportData": {},
        "date": "2026-11-23",
        "createdAt": "2026-11-23T04:45:30.000Z",
        "updatedAt": "2026-11-23T04:45:30.000Z",
        "deletedAt": null,
        "version": 1,
        "changeSequence": "1042"
      }
    },
    {
      "kind": "relationship",
      "data": {
        "reportId": "report_m4rf2z6ax8k1",
        "groupId": "group_q7a2",
        "createdAt": "2026-11-23T04:46:00.000Z",
        "updatedAt": "2026-11-23T04:46:00.000Z",
        "deletedAt": null,
        "version": 1,
        "changeSequence": "1044"
      }
    }
  ],
  "nextCursor": "1044",
  "hasMore": false
}
```

Persist `nextCursor` only after all returned changes have been committed to local storage. If applying the page fails, retain the old cursor and retry. Never advance the pull cursor from a mutation result's `changeSequence`; a compound delete can emit earlier relationship tombstones in the same transaction. Changes are globally ordered across all three entity types. The backend takes a per-user transactional lock while establishing the page watermark so a sequence allocated by an uncommitted mutation cannot be skipped.

Deleted records have `deletedAt != null`. Report contents and group descriptions are redacted on server deletion; the stable ID, version, sequence, and timestamps remain so every device can apply the tombstone. Tombstones are not purged because no device-acknowledgement protocol yet proves that every old offline installation has observed them.

## Conflict handling

There is no last-write-wins update. Every mutable record has a positive integer `version`:

1. A local create uses no prior record version (a new relationship uses `expectedVersion: 0`).
2. Store the returned/downloaded server version locally.
3. An update/delete supplies that version.
4. On success, replace it with the response version.
5. On `409`, pull changes and either present a conflict to the user or build an intentional merged update against the new version.

A tombstoned report cannot be updated or recreated under the same account-scoped ID. This prevents an old offline client from resurrecting deleted health data. An intentional recreation must use a new report ID.

## Required mobile integration

The current mobile source remains unchanged in this phase. Its next implementation phase must:

1. Add local synchronization metadata additively (at minimum `server_version`, `updated_at`, `deleted_at`, dirty state, and a durable UUID `mutation_id` for each pending operation). Do not drop/recreate local tables.
2. Store one pull cursor per authenticated backend account, never one device-global cursor.
3. Continue filtering local UI reads by the currently authenticated account immediately; cloud sync is not a substitute for local isolation.
4. Parse local `answers` and `report_data` JSON strings for upload and serialize downloaded JSON back into those columns.
5. Never send a local owner field. The server derives ownership from the token.
6. Keep the same mutation UUID for every retry. Generate a new UUID only for a new logical edit.
7. Upload account-owned pending parent records before relationship records. Retain pending operations until acknowledged.
8. Apply each pull page and its cursor in one local transaction. Apply tombstones as deletes/hidden local tombstones, including relationship tombstones.
9. On sign-in/new device: pull from the stored account cursor (or `0`), merge; push eligible dirty account-owned records; then pull again until caught up. Retry network failures with backoff.
10. On `409`, do not overwrite blindly. Pull the server version and resolve explicitly.

## Legacy local-only records

Records whose local owner is `"user"`, `"web"`, empty, `NULL`, or otherwise ambiguous must remain local and quarantined. They must not be uploaded, assigned to the first account that signs in, deleted, or overwritten.

A safe future migration needs an explicit user review/claim flow. It should show only on-device records, require a deliberate choice of destination account, assign fresh mutation UUIDs, preserve original IDs only when no same-account cloud record exists, and leave the originals untouched until the complete cloud transaction is acknowledged. Automatic ownership inference is not safe.

Guest-owned data is also not accepted implicitly by these authenticated routes. A future guest-to-account transfer must be an explicit client action with the existing local ownership checks.

## Operational notes

- Migration `0011_health_report_cloud_sync.sql` is additive and must be applied before deploying the routes.
- No public URLs or anonymous report routes exist.
- The idempotency table stores hashes and result metadata, not report payloads.
- Report deletion removes the sensitive JSON/name/email from the cloud row while retaining a minimal tombstone.
- Runtime migration, endpoint, load, and multi-device behavior still require verification in a non-production environment before release.
