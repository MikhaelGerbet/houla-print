# Hou.la Print

Desktop application (Electron) for automatic label printing when shop orders are paid on [Hou.la](https://hou.la).

## Features

- **Real-time printing**: Receives print jobs via WebSocket as soon as an order is paid
- **Multi-workspace**: Monitor multiple shops simultaneously
- **Multi-printer**: Route job types to different printers (thermal, receipt, standard)
- **ZPL labels**: Product labels on Zebra thermal printers (57×32mm)
- **ESC/POS receipts**: Order summaries on receipt printers
- **PDF printing**: Invoices and shipping labels
- **Offline resilient**: Jobs queue server-side, app fetches on reconnect
- **System tray**: Runs silently in background with notifications

## Architecture

```
Server (Hou.la API)          Desktop (Electron)
┌──────────────────┐         ┌──────────────────┐
│ Shop Order Paid  │──WS──▶  │ Socket.IO Client │
│ PrintOrderListener│         │ QueueService     │
│ PrintJob created │──REST─▶  │ PrinterService   │
│ WebSocket push   │         │ 🖨️ ZPL/ESC/PDF   │
└──────────────────┘         └──────────────────┘
```

## Development

### Prerequisites

- Node.js 20+
- npm 10+

### Setup

```bash
cd houla-print
npm install
```

### Run in development

```bash
npm run dev
```

The app auto-detects the environment at startup:

1. `--dev` CLI flag → `development`
2. `NODE_ENV=development` → `development`
3. `app.isPackaged === false` (running via `electron .`) → `development`
4. Otherwise → `production`

In **development** mode:
- API points to `http://localhost:53001`
- OAuth redirects to `https://localhost:59223`
- A yellow **DEV** badge is displayed in the titlebar
- Settings panel shows current env and API URL

### Build

```bash
npm run build    # Compile TypeScript
npm run start    # Run compiled Electron app
```

### Package for distribution

```bash
npm run dist:win   # Windows .exe installer
npm run dist:mac   # macOS .dmg
```

## Project Structure

```
houla-print/
├── assets/                  # App icons and images
├── scripts/                 # Build helper scripts
├── src/
│   ├── main/                # Main process (Node.js)
│   │   ├── index.ts         # App entry point (window, tray, IPC)
│   │   └── services/
│   │       ├── api.service.ts       # HTTP client for Hou.la API
│   │       ├── auth.service.ts      # OAuth 2.0 PKCE flow
│   │       ├── printer.service.ts   # Printer detection + raw printing
│   │       ├── queue.service.ts     # Local print queue with retry
│   │       ├── socket.service.ts    # Socket.IO client (multi-workspace)
│   │       ├── store.service.ts     # Encrypted config (electron-store)
│   │       └── workspace.service.ts # Workspace + API key management
│   ├── preload/             # Preload script (IPC bridge)
│   │   └── index.ts
│   ├── renderer/            # UI (plain HTML/CSS/JS)
│   │   ├── index.html
│   │   ├── styles.css
│   │   └── renderer.js
│   └── shared/              # Shared types and config
│       ├── config.ts
│       └── types.ts
├── package.json
├── tsconfig.json
├── tsconfig.main.json
└── tsconfig.preload.json
```

## Auth Flow

1. User clicks "Se connecter avec Hou.la"
2. System browser opens → Hou.la OAuth page (PKCE challenge)
3. User logs in → redirect to `houla-print://callback?code=...`
4. App exchanges code for JWT tokens
5. Fetches workspaces → creates API keys per enabled workspace
6. Connects Socket.IO with API Key auth
7. Subscribes to `workspace:{id}` rooms for real-time events

## Print Routing

| Job Type | Format | Typical Printer |
|---|---|---|
| Product label | ZPL 57×32mm | Zebra thermal |
| Order summary | ESC/POS 80mm | Receipt printer |
| Invoice | PDF A4 | Laser/inkjet |
| Shipping label | PDF 10×15cm | Thermal or laser |
| Packing slip | PDF A4 | Laser/inkjet |

User assigns printers per job type in the app settings.

## API Endpoints Used

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/workspaces` | JWT | List user workspaces |
| `POST` | `/api/manager/api-keys` | JWT | Create API key per workspace |
| `GET` | `/api/print/jobs?status=pending` | API Key | Fetch pending jobs |
| `POST` | `/api/print/jobs/:id/ack` | API Key | Acknowledge job |
| `GET` | `/api/print/jobs/:id/label` | API Key | Download label content |
| `GET` | `/api/print/config` | API Key | Get print config |

## License

Proprietary — All rights reserved.
