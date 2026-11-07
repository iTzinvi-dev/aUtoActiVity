import {initializeApp, getApps, getApp, FirebaseApp} from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
  Auth,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
  Firestore,
} from 'firebase/firestore';

export let app!: FirebaseApp;
export let db!: Firestore;
export let auth!: Auth;
export const googleProvider = new GoogleAuthProvider();

let initPromise: Promise<boolean> | null = null;

/**
 * Dynamically initializes Firebase on the browser using the server-side runtime
 * bootstrap endpoint (/api/pipeline/firebase-bootstrap) so that NO Google API key
 * is ever hardcoded or bundled in the frontend source files or GitHub repository.
 */
export function ensureFirebaseInitialized(): Promise<boolean> {
  if (typeof window === 'undefined') {
    return Promise.resolve(false);
  }
  if (db && auth) {
    return Promise.resolve(true);
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const resp = await fetch('/api/pipeline/firebase-bootstrap', {
        headers: {Accept: 'application/json'},
      });
      if (!resp.ok) {
        return false;
      }
      const data = (await resp.json()) as {bootstrapToken?: string};
      if (!data.bootstrapToken) {
        return false;
      }
      const decodedJson = atob(data.bootstrapToken);
      const firebaseConfig = JSON.parse(decodedJson) as {
        apiKey?: string;
        authDomain?: string;
        projectId?: string;
        storageBucket?: string;
        messagingSenderId?: string;
        appId?: string;
        firestoreDatabaseId?: string;
      };
      if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
        return false;
      }

      app =
        getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
      db = firebaseConfig.firestoreDatabaseId
        ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
        : getFirestore(app);
      auth = getAuth(app);
      return true;
    } catch {
      return false;
    }
  })();

  return initPromise;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<boolean> {
  try {
    const ready = await ensureFirebaseInitialized();
    if (!ready || !db) return false;
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('the client is offline')
    ) {
      console.error('Please check your Firebase configuration.');
      return false;
    }
    // Permission denied on /test/connection is expected and confirms live server connectivity
    return true;
  }
}

export {
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
};
export type {User};
