Turn-Based Bonk (Colyseus + Phaser)

Quickstart
- Prereqs: Node.js 18+ installed.
- Terminal A:
  - `cd server`
  - `npm install`
  - `npm run dev` (starts Colyseus at `ws://localhost:2567`)
- Terminal B:
  - `cd client`
  - `npm install`
  - `npm run dev` (serves UI at `http://localhost:1234`)
- Open two browser tabs at `http://localhost:1234` to see turns rotate every 30s.

Gameplay Notes
- Bonk-like circles in an arena; only the active player can move.
- Turn length is 30 seconds, with Space to pass the turn early.
- Arrow keys or WASD to move when it’s your turn.

Structure
- `server/` Node + TypeScript + Colyseus.
  - Room: `turn_bonk` with `TurnBasedBonkRoom` and schema for players + turn state.
- `client/` Parcel + TypeScript + Phaser 3 + colyseus.js.
  - Scene connects to room, renders circles, highlights active, and shows countdown.

Implementation Highlights
- Server enforces turn-taking, ignoring input from non-active clients.
- Fixed simulation step via `setSimulationInterval`, 20Hz interpolation on client.
- Minimal arena bounds; easy to extend with collisions/physics later.

