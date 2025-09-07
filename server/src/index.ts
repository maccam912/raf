import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { TurnBasedRAFRoom } from "./rooms/TurnBasedRAFRoom";

const PORT = Number(process.env.PORT) || 2567;

async function main() {
  const app = express();
  app.use(cors());
  app.get("/health", (_req, res) => res.send("ok"));

  const httpServer = http.createServer(app);
  const gameServer = new Server({ server: httpServer });

  gameServer.define("rebate_attack_force", TurnBasedRAFRoom);

  gameServer.listen(PORT);
  console.log(`Colyseus listening on ws://localhost:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
