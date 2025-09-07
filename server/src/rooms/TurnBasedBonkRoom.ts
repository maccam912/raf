import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";

class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") radius: number = 16;
  @type("string") color: string = "#2d8cf0";
}

class TurnBasedBonkState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("string") activeTurnSessionId: string = "";
  @type("number") turnRemainingMs: number = 0; // server-derived countdown for convenience
}

type InputPayload = {
  left?: boolean;
  right?: boolean;
  up?: boolean;
  down?: boolean;
};

export class TurnBasedBonkRoom extends Room<TurnBasedBonkState> {
  maxClients = 8;

  private inputBuffer: Map<string, InputPayload> = new Map();
  private turnDurationMs = 30_000; // 30 seconds per turn
  private turnEndsAt = 0; // epoch ms

  private worldWidth = 800;
  private worldHeight = 600;
  private speed = 200; // px / second for active player

  onCreate() {
    this.setState(new TurnBasedBonkState());

    this.onMessage("input", (client, message: InputPayload) => {
      if (client.sessionId !== this.state.activeTurnSessionId) return;
      this.inputBuffer.set(client.sessionId, message);
    });

    this.onMessage("endTurn", (client) => {
      if (client.sessionId === this.state.activeTurnSessionId) {
        this.advanceTurn();
      }
    });

    this.setSimulationInterval((deltaTime) => this.fixedTick(deltaTime));
  }

  onJoin(client: Client) {
    const player = new Player();
    player.x = Math.random() * (this.worldWidth - 100) + 50;
    player.y = Math.random() * (this.worldHeight - 100) + 50;
    player.color = this.randomColor();
    this.state.players.set(client.sessionId, player);

    // If this is the first player, start the turn timer.
    if (!this.state.activeTurnSessionId) {
      this.state.activeTurnSessionId = client.sessionId;
      this.turnEndsAt = Date.now() + this.turnDurationMs;
    }
  }

  onLeave(client: Client) {
    const wasActive = client.sessionId === this.state.activeTurnSessionId;
    this.state.players.delete(client.sessionId);
    this.inputBuffer.delete(client.sessionId);

    if (wasActive) {
      this.advanceTurn();
    }
  }

  private fixedTick(deltaTime: number) {
    // Update countdown
    const now = Date.now();
    this.state.turnRemainingMs = Math.max(0, this.turnEndsAt - now);

    if (this.state.turnRemainingMs === 0 && this.state.activeTurnSessionId) {
      this.advanceTurn();
    }

    // Move only the active player from buffered input
    const activeId = this.state.activeTurnSessionId;
    if (activeId) {
      const player = this.state.players.get(activeId);
      if (player) {
        const input = this.inputBuffer.get(activeId) || {};

        const dt = deltaTime / 1000;
        let dx = 0;
        let dy = 0;
        if (input.left) dx -= 1;
        if (input.right) dx += 1;
        if (input.up) dy -= 1;
        if (input.down) dy += 1;
        if (dx !== 0 || dy !== 0) {
          const len = Math.hypot(dx, dy) || 1;
          dx /= len;
          dy /= len;
        }
        player.x += dx * this.speed * dt;
        player.y += dy * this.speed * dt;

        // clamp to world bounds (simple arena)
        player.x = Math.max(player.radius, Math.min(this.worldWidth - player.radius, player.x));
        player.y = Math.max(player.radius, Math.min(this.worldHeight - player.radius, player.y));
      }
    }
  }

  private advanceTurn() {
    const ids = Array.from(this.state.players.keys());
    if (ids.length === 0) {
      this.state.activeTurnSessionId = "";
      this.state.turnRemainingMs = 0;
      return;
    }

    const current = this.state.activeTurnSessionId;
    const currentIdx = Math.max(0, ids.indexOf(current));
    const nextIdx = (currentIdx + 1) % ids.length;
    const nextId = ids[nextIdx];

    this.state.activeTurnSessionId = nextId;
    this.turnEndsAt = Date.now() + this.turnDurationMs;
    this.state.turnRemainingMs = this.turnDurationMs;
  }

  private randomColor() {
    const colors = ["#2d8cf0", "#19be6b", "#ff9900", "#ed3f14", "#9a66e4", "#00bcd4", "#ff4081"];
    return colors[(Math.random() * colors.length) | 0];
  }
}

