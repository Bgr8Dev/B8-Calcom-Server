# Cal.com Server Quick Start

This server acts as a proxy between the frontend and Cal.com's API to handle CORS and API key authentication.

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
- **Endpoints**:
  - `GET /bookings?username=...&apiKey=...&startTime=...&endTime=...`
  - `GET /event-types?username=...&apiKey=...`

## Environment Variables

Create a `.env` file in the root directory (optional):
```
PORT=4000
```

## Troubleshooting

If you see `ERR_CONNECTION_REFUSED`:
1. Make sure the Cal.com server is running on port 4000
2. Check that port 4000 is not already in use
3. Verify the CSP in `index.html` allows `http://localhost:4000`

