# Repository Guidelines

## Project Structure & Module Organization
- Root: `dev.js` (orchestrates dev), `README.md`, `package.json` (runner scripts).
- Server (`server/`): Node + TypeScript + Colyseus. Entry `src/index.ts`; rooms in `src/rooms/` (e.g., `TurnBasedBonkRoom.ts`, `TurnBasedRAFRoom.ts`). Builds to `dist/`.
- Client (`client/`): Parcel + TypeScript + Phaser. Entry `index.html` + `index.ts`.

## Build, Test, and Development Commands
- Root dev (start both): `npm run dev` (spawns server and client; frees port 2567 first).
- Server only: `npm --prefix server install && npm --prefix server run dev`.
- Client only: `npm --prefix client install && npm --prefix client run dev`.
- Build both: `npm run build` (server: `tsc`; client: `parcel build`).
- Health check: `GET http://localhost:2567/health` → `ok`.

## Coding Style & Naming Conventions
- Language: TypeScript (TS 5.x). `strict` is disabled by default.
- Indentation: 2 spaces; use semicolons; prefer double quotes.
- Naming: PascalCase for classes (`TurnBasedBonkRoom`), camelCase for variables/functions, UPPER_SNAKE_CASE for constants.
- File layout: server rooms under `server/src/rooms/NameRoom.ts`; keep client scene/game code in `client/index.ts` or submodules.
- Lint/format: No enforced linter; keep imports tidy and code consistent with existing files.

## Testing Guidelines
- Automated tests are not yet configured (`npm test` is a placeholder).
- Manual verification:
  - Run `npm run dev`.
  - Open `http://localhost:1234` in two tabs; ensure turn rotation and movement work; check `/health`.
- If adding tests later, prefer Jest/Vitest for client and lightweight Node tests for server.

## Commit & Pull Request Guidelines
- Use Conventional Commits: `feat(server): ...`, `fix(client): ...`, `chore: ...`.
- Keep scopes small (`server`, `client`, `rooms`, etc.).
- PRs must include: clear description, linked issues, steps to verify (commands + expected results), and screenshots/video for client UI when relevant.

## Security & Configuration Tips
- Ports: server WS `2567`, client `1234`. `dev.js`/`kill-port.js` free 2567 on start.
- Do not commit secrets. Use `PORT` env to override the server port locally.

## Agent-Specific Instructions
- Follow this structure; avoid renaming routes/ports without request.
- Minimize diffs; match existing style; avoid adding deps unless necessary.
- Keep changes scoped to relevant folders (`server/`, `client/`).
