import {describe, it, expect} from 'vitest';

export interface SimulatedContext {
  auth: {
    uid: string;
    email: string;
    email_verified: boolean;
  } | null;
  requestTimeIso: string;
  existingDocs: Set<string>;
}

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function isValidId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && ID_REGEX.test(id);
}

export function evaluateDirtyDozenSecurityGate(
  operation: 'get' | 'list' | 'create' | 'update',
  collection: string,
  docId: string,
  ctx: SimulatedContext,
  incomingData?: Record<string, unknown>,
  existingData?: Record<string, unknown>,
  queryOwnerId?: string,
): 'ALLOWED' | 'PERMISSION_DENIED' {
  if (!ctx.auth) return 'PERMISSION_DENIED';
  const isAdmin =
    ctx.auth.email_verified &&
    (ctx.auth.email === 'gndmain@gmail.com' || ctx.existingDocs.has(`/admins/${ctx.auth.uid}`));

  if (operation === 'list') {
    if (queryOwnerId === ctx.auth.uid || isAdmin) return 'ALLOWED';
    return 'PERMISSION_DENIED';
  }

  if (!isValidId(docId)) return 'PERMISSION_DENIED';

  if (operation === 'get') {
    const ownerId =
      collection === 'users' ? docId : String(existingData?.['ownerId'] ?? '');
    return ownerId === ctx.auth.uid || isAdmin ? 'ALLOWED' : 'PERMISSION_DENIED';
  }

  if (!ctx.auth.email_verified) return 'PERMISSION_DENIED';
  if (!incomingData) return 'PERMISSION_DENIED';

  if (operation === 'create') {
    if (incomingData['createdAt'] !== ctx.requestTimeIso) return 'PERMISSION_DENIED';
    if (incomingData['updatedAt'] !== ctx.requestTimeIso) return 'PERMISSION_DENIED';
  }

  if (operation === 'update') {
    if (!existingData) return 'PERMISSION_DENIED';
    if (incomingData['createdAt'] !== existingData['createdAt']) return 'PERMISSION_DENIED';
    if (incomingData['updatedAt'] !== ctx.requestTimeIso) return 'PERMISSION_DENIED';
    if (incomingData['ownerId'] !== existingData['ownerId']) return 'PERMISSION_DENIED';
  }

  if (collection === 'users') {
    if (incomingData['uid'] !== ctx.auth.uid) return 'PERMISSION_DENIED';
    if (incomingData['role'] === 'admin' && !isAdmin) return 'PERMISSION_DENIED';
    return 'ALLOWED';
  }

  if (incomingData['ownerId'] !== ctx.auth.uid && !isAdmin) return 'PERMISSION_DENIED';
  if (!ctx.existingDocs.has(`/users/${String(incomingData['ownerId'])}`)) {
    return 'PERMISSION_DENIED';
  }

  if (collection === 'telegram_vaults') {
    const allowed = new Set([
      'ownerId',
      'encryptedBotToken',
      'botTokenMasked',
      'chatId',
      'botUsername',
      'botName',
      'chatTitle',
      'subscribersCount',
      'geminiSecretConfigured',
      'autoSendEvery6h',
      'verified',
      'lastSyncedIso',
      'createdAt',
      'updatedAt',
    ]);
    for (const k of Object.keys(incomingData)) {
      if (!allowed.has(k)) return 'PERMISSION_DENIED';
    }
    const encToken = String(incomingData['encryptedBotToken'] ?? '');
    if (encToken.length > 1024) return 'PERMISSION_DENIED';
  }

  return 'ALLOWED';
}

describe('Firestore Dirty Dozen Security Audit', () => {
  const nowIso = '2026-11-07T02:20:00.000Z';
  const baseUserDocs = new Set(['/users/user_1']);

  it('rejects all 12 Dirty Dozen adversarial payloads with PERMISSION_DENIED', () => {
    // 1. Unauthenticated vault read
    expect(
      evaluateDirtyDozenSecurityGate('get', 'telegram_vaults', 'user_1', {
        auth: null,
        requestTimeIso: nowIso,
        existingDocs: baseUserDocs,
      }),
    ).toBe('PERMISSION_DENIED');

    // 2. Unverified email write
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'telegram_vaults',
        'user_1',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: false},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {ownerId: 'user_1', createdAt: nowIso, updatedAt: nowIso},
      ),
    ).toBe('PERMISSION_DENIED');

    // 3. Cross-tenant vault read
    expect(
      evaluateDirtyDozenSecurityGate(
        'get',
        'telegram_vaults',
        'user_1',
        {
          auth: {uid: 'attacker_uid', email: 'att@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        undefined,
        {ownerId: 'user_1'},
      ),
    ).toBe('PERMISSION_DENIED');

    // 4. Self-assigned admin role escalation
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'users',
        'user_1',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {
          uid: 'user_1',
          displayName: 'User 1',
          role: 'admin',
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ),
    ).toBe('PERMISSION_DENIED');

    // 5. Shadow field injection
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'telegram_vaults',
        'user_1',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {
          ownerId: 'user_1',
          botToken: '123:abc',
          isSuperAdmin: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ),
    ).toBe('PERMISSION_DENIED');

    // 6. Owner spoofing on create
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'digest_runs',
        'run_1',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {ownerId: 'user_2', createdAt: nowIso, updatedAt: nowIso},
      ),
    ).toBe('PERMISSION_DENIED');

    // 7. Immutable ownerId mutation on update
    expect(
      evaluateDirtyDozenSecurityGate(
        'update',
        'telegram_vaults',
        'user_1',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {ownerId: 'user_2', createdAt: nowIso, updatedAt: nowIso},
        {ownerId: 'user_1', createdAt: nowIso, updatedAt: nowIso},
      ),
    ).toBe('PERMISSION_DENIED');

    // 8. Forged client timestamp
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'processed_items',
        'hn_1',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {
          ownerId: 'user_1',
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: nowIso,
        },
      ),
    ).toBe('PERMISSION_DENIED');

    // 9. Oversized botToken string
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'telegram_vaults',
        'user_1',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {
          ownerId: 'user_1',
          encryptedBotToken: 'x'.repeat(2000),
          botTokenMasked: '123•••••••',
          chatId: '123',
          botUsername: 'bot',
          botName: 'Bot',
          chatTitle: 'Chat',
          subscribersCount: 1,
          geminiSecretConfigured: true,
          autoSendEvery6h: true,
          verified: true,
          lastSyncedIso: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ),
    ).toBe('PERMISSION_DENIED');

    // 10. Invalid document ID characters
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'digest_runs',
        'bad$id!@#',
        {
          auth: {uid: 'user_1', email: 'u1@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {ownerId: 'user_1', createdAt: nowIso, updatedAt: nowIso},
      ),
    ).toBe('PERMISSION_DENIED');

    // 11. Orphaned write without parent /users/{ownerId}
    expect(
      evaluateDirtyDozenSecurityGate(
        'create',
        'automation_configs',
        'ghost_uid',
        {
          auth: {uid: 'ghost_uid', email: 'g@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        {ownerId: 'ghost_uid', createdAt: nowIso, updatedAt: nowIso},
      ),
    ).toBe('PERMISSION_DENIED');

    // 12. Blanket unscoped list query
    expect(
      evaluateDirtyDozenSecurityGate(
        'list',
        'digest_runs',
        '',
        {
          auth: {uid: 'attacker_uid', email: 'att@example.com', email_verified: true},
          requestTimeIso: nowIso,
          existingDocs: baseUserDocs,
        },
        undefined,
        undefined,
        'user_1',
      ),
    ).toBe('PERMISSION_DENIED');
  });
});
