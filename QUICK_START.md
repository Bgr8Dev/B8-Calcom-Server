# Cal.com Server Quick Start

This server acts as a secure proxy between the frontend and Cal.com's API, storing Cal.com tokens server-side and enforcing Firebase Auth on requests.

## Running the Server

### Option 1: Run Both Servers Together (Recommended)
```bash
npm run dev:all
```
This will start both the Vite dev server and the Cal.com proxy server simultaneously.

### Option 2: Run Servers Separately
Terminal 1 (Frontend):
```bash
npm run dev
```

Terminal 2 (Cal.com Proxy):
```bash
npm run calcom:server
```

## Server Details

- **Port**: 4000 (default, can be changed via `PORT` environment variable)
- **Health Check**: `http://localhost:4000/`
- **Auth**: All non-health endpoints require `Authorization: Bearer <Firebase_ID_Token>`
- **Endpoints**:
  - `POST /tokens` (store token)
  - `GET /tokens/status?mentorUid=...` (status + username)
  - `DELETE /tokens` (remove token)
  - `POST /calcom/event-types`
  - `POST /calcom/bookings/list`
  - `POST /calcom/bookings`
  - `POST /calcom/bookings/cancel`
  - `POST /calcom/availability`
  - `POST /calcom/schedules`

## Environment Variables

Create a `.env` file in the root directory (required for production):
```
PORT=4000
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account-email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

## Troubleshooting

If you see `ERR_CONNECTION_REFUSED`:
1. Make sure the Cal.com server is running on port 4000
2. Check that port 4000 is not already in use
3. Verify the CSP in `index.html` allows `http://localhost:4000`
4. Ensure Firebase Admin credentials are set in the server environment

