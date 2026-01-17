// Cal.com proxy server with secure token storage
import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { serverLogger } from './logger.mjs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const CALCOM_API_BASE = 'https://api.cal.com/v2';
const TOKEN_COLLECTION = 'calcomTokensSecure';
const LEGACY_TOKEN_COLLECTION = 'calcomTokens';

app.use(cors());
app.use(express.json());

const hasFirebaseConfig = () =>
  !!process.env.FIREBASE_PROJECT_ID &&
  !!process.env.FIREBASE_CLIENT_EMAIL &&
  !!process.env.FIREBASE_PRIVATE_KEY;

if (!admin.apps.length) {
  if (!hasFirebaseConfig()) {
    serverLogger.error('Missing Firebase Admin configuration for Cal.com server.');
    process.exit(1);
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const firestore = admin.firestore();

const getBearerToken = (req) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
};

const authenticateRequest = async (req, res, next) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Missing auth token' });
    }
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.auth = { uid: decodedToken.uid, email: decodedToken.email };
    return next();
  } catch (error) {
    serverLogger.warn('Auth token verification failed.', error);
    return res.status(401).json({ error: 'Invalid auth token' });
  }
};

const isAdminUser = async (uid) => {
  const userDoc = await firestore.collection('users').doc(uid).get();
  if (!userDoc.exists) return false;
  const data = userDoc.data() || {};
  const roles = data.roles || {};
  return roles.admin === true || data.admin === true;
};

const resolveTargetUid = async (req) => {
  const requestedUid = req.body?.mentorUid || req.query?.mentorUid;
  if (!requestedUid || requestedUid === req.auth.uid) {
    return req.auth.uid;
  }
  const isAdmin = await isAdminUser(req.auth.uid);
  if (!isAdmin) {
    throw new Error('Not authorized to access this mentor');
  }
  return requestedUid;
};

const getTokenDoc = async (uid) => {
  const tokenDoc = await firestore.collection(TOKEN_COLLECTION).doc(uid).get();
  if (tokenDoc.exists) {
    return tokenDoc.data();
  }

  const legacyDoc = await firestore.collection(LEGACY_TOKEN_COLLECTION).doc(uid).get();
  if (!legacyDoc.exists) {
    return null;
  }

  const legacyData = legacyDoc.data() || {};
  if (!legacyData.apiKey || !legacyData.calComUsername) {
    return null;
  }

  await firestore.collection(TOKEN_COLLECTION).doc(uid).set(
    {
      mentorUid: uid,
      apiKey: legacyData.apiKey,
      calComUsername: legacyData.calComUsername,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      migratedFromLegacy: true,
    },
    { merge: true }
  );
  await firestore.collection(LEGACY_TOKEN_COLLECTION).doc(uid).delete();
  serverLogger.info('Migrated legacy Cal.com token for mentor:', uid);
  return { ...legacyData, migratedFromLegacy: true };
};

const getTokenOrThrow = async (uid) => {
  const tokenDoc = await getTokenDoc(uid);
  if (!tokenDoc || !tokenDoc.apiKey || !tokenDoc.calComUsername) {
    throw new Error('Cal.com token not configured');
  }
  return tokenDoc;
};

const callCalcomApi = async ({ endpoint, apiKey, query, method = 'GET', body }) => {
  const url = new URL(`${CALCOM_API_BASE}${endpoint}`);
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.append(key, String(value));
      }
    });
  }
  const response = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
};

app.get('/', (_req, res) => {
  res.send('Cal.com Proxy Server is running');
});

app.post('/tokens', authenticateRequest, async (req, res) => {
  try {
    const { apiKey, calComUsername } = req.body || {};
    if (!apiKey || !calComUsername) {
      return res.status(400).json({ error: 'apiKey and calComUsername are required' });
    }
    await firestore.collection(TOKEN_COLLECTION).doc(req.auth.uid).set(
      {
        mentorUid: req.auth.uid,
        apiKey,
        calComUsername,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    serverLogger.info('Cal.com API key stored for mentor:', req.auth.uid);
    return res.json({ success: true, calComUsername });
  } catch (error) {
    serverLogger.error('Error storing Cal.com API key:', error);
    return res.status(500).json({ error: 'Failed to store Cal.com API key' });
  }
});

app.get('/tokens/status', authenticateRequest, async (req, res) => {
  try {
    const uid = await resolveTargetUid(req);
    const tokenDoc = await getTokenDoc(uid);
    if (!tokenDoc) {
      return res.json({ connected: false });
    }
    return res.json({ connected: true, calComUsername: tokenDoc.calComUsername || '' });
  } catch (error) {
    serverLogger.error('Error fetching Cal.com token status:', error);
    return res.status(403).json({ error: error.message || 'Unauthorized' });
  }
});

app.delete('/tokens', authenticateRequest, async (req, res) => {
  try {
    const uid = await resolveTargetUid(req);
    await firestore.collection(TOKEN_COLLECTION).doc(uid).delete();
    serverLogger.info('Cal.com API key removed for mentor:', uid);
    return res.json({ success: true });
  } catch (error) {
    serverLogger.error('Error removing Cal.com API key:', error);
    return res.status(403).json({ error: error.message || 'Unauthorized' });
  }
});

app.post('/calcom/event-types', authenticateRequest, async (req, res) => {
  try {
    const uid = await resolveTargetUid(req);
    const tokenDoc = await getTokenOrThrow(uid);
    serverLogger.debug('Fetching Cal.com event types for:', uid);
    const { response, data } = await callCalcomApi({
      endpoint: '/event-types',
      apiKey: tokenDoc.apiKey,
      query: { username: tokenDoc.calComUsername },
    });
    return res.status(response.status).json(data);
  } catch (error) {
    serverLogger.error('Cal.com event types proxy error:', error);
    return res.status(500).json({ error: error.message || 'Proxy error' });
  }
});

app.post('/calcom/bookings/list', authenticateRequest, async (req, res) => {
  try {
    const { startTime, endTime } = req.body || {};
    const uid = await resolveTargetUid(req);
    const tokenDoc = await getTokenOrThrow(uid);
    serverLogger.debug('Fetching Cal.com bookings for:', uid);
    const { response, data } = await callCalcomApi({
      endpoint: '/bookings',
      apiKey: tokenDoc.apiKey,
      query: {
        username: tokenDoc.calComUsername,
        startTime,
        endTime,
        start: startTime,
        end: endTime,
      },
    });
    return res.status(response.status).json(data);
  } catch (error) {
    serverLogger.error('Cal.com bookings proxy error:', error);
    return res.status(500).json({ error: error.message || 'Proxy error' });
  }
});

app.post('/calcom/bookings', authenticateRequest, async (req, res) => {
  try {
    const { bookingRequest } = req.body || {};
    if (!bookingRequest) {
      return res.status(400).json({ error: 'bookingRequest is required' });
    }
    const uid = await resolveTargetUid(req);
    const tokenDoc = await getTokenOrThrow(uid);
    serverLogger.info('Creating Cal.com booking for:', uid);
    const { response, data } = await callCalcomApi({
      endpoint: '/bookings',
      apiKey: tokenDoc.apiKey,
      method: 'POST',
      body: {
        ...bookingRequest,
        username: tokenDoc.calComUsername,
      },
    });
    return res.status(response.status).json(data);
  } catch (error) {
    serverLogger.error('Cal.com booking proxy error:', error);
    return res.status(500).json({ error: error.message || 'Proxy error' });
  }
});

app.post('/calcom/bookings/cancel', authenticateRequest, async (req, res) => {
  try {
    const { bookingId, reason } = req.body || {};
    if (!bookingId) {
      return res.status(400).json({ error: 'bookingId is required' });
    }
    const uid = await resolveTargetUid(req);
    const tokenDoc = await getTokenOrThrow(uid);
    serverLogger.info('Canceling Cal.com booking for:', uid);
    const { response, data } = await callCalcomApi({
      endpoint: `/bookings/${bookingId}`,
      apiKey: tokenDoc.apiKey,
      method: 'DELETE',
      body: reason ? { reason } : undefined,
    });
    return res.status(response.status).json(data);
  } catch (error) {
    serverLogger.error('Cal.com booking cancellation error:', error);
    return res.status(500).json({ error: error.message || 'Proxy error' });
  }
});

app.post('/calcom/availability', authenticateRequest, async (req, res) => {
  try {
    const { dateFrom, dateTo, eventTypeId } = req.body || {};
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: 'dateFrom and dateTo are required' });
    }
    const uid = await resolveTargetUid(req);
    const tokenDoc = await getTokenOrThrow(uid);
    serverLogger.debug('Fetching Cal.com availability for:', uid);
    const { response, data } = await callCalcomApi({
      endpoint: '/availability',
      apiKey: tokenDoc.apiKey,
      query: {
        username: tokenDoc.calComUsername,
        dateFrom,
        dateTo,
        eventTypeId,
      },
    });
    return res.status(response.status).json(data);
  } catch (error) {
    serverLogger.error('Cal.com availability proxy error:', error);
    return res.status(500).json({ error: error.message || 'Proxy error' });
  }
});

app.post('/calcom/schedules', authenticateRequest, async (req, res) => {
  try {
    const uid = await resolveTargetUid(req);
    const tokenDoc = await getTokenOrThrow(uid);
    serverLogger.debug('Fetching Cal.com schedules for:', uid);
    const { response, data } = await callCalcomApi({
      endpoint: '/schedules',
      apiKey: tokenDoc.apiKey,
      query: { username: tokenDoc.calComUsername },
    });
    return res.status(response.status).json(data);
  } catch (error) {
    serverLogger.error('Cal.com schedules proxy error:', error);
    return res.status(500).json({ error: error.message || 'Proxy error' });
  }
});

app.listen(PORT, () => {
  serverLogger.info(`Cal.com proxy server running on http://localhost:${PORT}`);
});