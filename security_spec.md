# Firestore Security Specification — Global Developer Pulse Pipeline

## 1. Data Invariants
1. **Default-Deny Catch-All**: Every collection or sub-collection not explicitly matched is unconditionally denied (`allow read, write: if false;`).
2. **Verified Operator Identity**: All write operations require `isSignedIn()` and `request.auth.token.email_verified == true`.
3. **Strict Owner & Admin Isolation**:
   - `/users/{userId}`: Only the authenticated owner (`request.auth.uid == userId`) or a verified admin (`isAdmin()`) may read or write their profile. Self-assigned `admin` role is forbidden unless `isAdmin()`.
   - `/telegram_vaults/{vaultId}`: Isolated secret vault containing Telegram Bot tokens and target chat IDs. Strictly readable and writable only by the owner (`resource.data.ownerId == request.auth.uid`) or `isAdmin()`.
   - `/automation_configs/{configId}`: 6-hour scheduler configuration documents. Must reference an existing `/users/$(incoming().ownerId)` record and belong to `request.auth.uid`.
   - `/digest_runs/{runId}`: 6-hour digest archive records. Must reference an existing `/users/$(incoming().ownerId)` record and enforce `resource.data.ownerId == request.auth.uid` on `get` and `list`.
   - `/processed_items/{itemId}`: Deduplicated Hacker News & DEV.to item records. Must reference an existing `/users/$(incoming().ownerId)` record and enforce `resource.data.ownerId == request.auth.uid` on `get` and `list`.
4. **Temporal & Immutable Integrity**:
   - On `create`: `incoming().createdAt == request.time && incoming().updatedAt == request.time`.
   - On `update`: `incoming().createdAt == existing().createdAt && incoming().updatedAt == request.time && incoming().ownerId == existing().ownerId`.
5. **Strict Key & Volumetric Boundaries**:
   - Every `create` and `update` invokes `isValid[Entity](incoming())`, enforcing `data.keys().hasAll(...)`, `data.keys().hasOnly(...)`, and explicit `.size()` bounds on every string.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 (Unauthenticated Vault Read)**: Unauthenticated client attempts `get(/telegram_vaults/user_1)` -> `PERMISSION_DENIED`.
2. **Payload 2 (Unverified Email Write)**: Authenticated user with `email_verified: false` attempts `create` on `/telegram_vaults/user_1` -> `PERMISSION_DENIED`.
3. **Payload 3 (Cross-Tenant Vault Theft)**: Verified user `attacker_uid` attempts `get(/telegram_vaults/victim_uid)` -> `PERMISSION_DENIED`.
4. **Payload 4 (Self-Assigned Admin Escalation)**: Non-admin user attempts `create` on `/users/attacker_uid` with `role: "admin"` -> `PERMISSION_DENIED`.
5. **Payload 5 (Shadow Field Injection)**: Owner attempts `update` on `/automation_configs/user_1` adding `{ isSuperAdmin: true }` -> `PERMISSION_DENIED` (`hasOnly` rejection).
6. **Payload 6 (Owner Spoofing on Create)**: User `user_1` attempts `create` on `/digest_runs/run_1` with `ownerId: "user_2"` -> `PERMISSION_DENIED`.
7. **Payload 7 (Immutable Owner Mutation on Update)**: User `user_1` attempts `update` on `/telegram_vaults/user_1` changing `ownerId` to `"user_2"` -> `PERMISSION_DENIED`.
8. **Payload 8 (Forged Client Timestamp)**: User `user_1` attempts `create` on `/processed_items/hn_1` with `createdAt` set to a past timestamp (`!= request.time`) -> `PERMISSION_DENIED`.
9. **Payload 9 (Denial-of-Wallet Oversized String)**: User `user_1` attempts `create` on `/telegram_vaults/user_1` with a 10,000-char `botToken` (`> 256`) -> `PERMISSION_DENIED`.
10. **Payload 10 (ID Poisoning Attack)**: User `user_1` attempts `create` on `/digest_runs/invalid$id!@#` failing `isValidId()` regex -> `PERMISSION_DENIED`.
11. **Payload 11 (Orphaned AutomationConfig Without User Doc)**: User `ghost_uid` (without `/users/ghost_uid`) attempts `create` on `/automation_configs/ghost_uid` -> `PERMISSION_DENIED` (`exists()` check).
12. **Payload 12 (Unscoped Blanket List Query)**: User `attacker_uid` attempts an unscoped `list` on `/digest_runs` without `where('ownerId', '==', 'attacker_uid')` -> `PERMISSION_DENIED`.
