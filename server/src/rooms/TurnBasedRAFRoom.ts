import { Room, Client } from "colyseus";
import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
// Server no longer runs physics; active client is authoritative for positions.

class Creature extends Schema {
  @type("string") id: string = "";
  @type("string") ownerSessionId: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") radius: number = 16;
  @type("string") color: string = "#2d8cf0";
}

class RAFState extends Schema {
  @type({ map: Creature }) creatures = new MapSchema<Creature>();
  @type("string") activePlayerSessionId: string = "";
  @type("string") activeCreatureId: string = "";
  @type("number") turnRemainingMs: number = 0;
  @type(["number"]) terrainPoints = new ArraySchema<number>(); // flattened [x0,y0,x1,y1,...]
  @type("number") waterline: number = 560;
}

type ImpulseMsg = { creatureId: string; fx: number; fy: number };
type StateMsg = { creatureId: string; x: number; y: number };

export class TurnBasedRAFRoom extends Room<RAFState> {
  maxClients = 8;

  private joinOrder: string[] = [];
  private lastCreatureIndexByPlayer: Map<string, number> = new Map();
  private turnDurationMs = 30_000;
  private turnEndsAt = 0;

  // Input/physics are client-authoritative now; server tracks only state and turn.

  // World dims
  private width = 800;
  private height = 600;
  private terrainHalfSpan = 4000; // total span ~8000px (left/right of origin)

  onCreate() {
    this.setState(new RAFState());

    // Build terrain and expose to state
    const pts = this.generateIslandTop(); // {x,y}[]
    const arr = new ArraySchema<number>();
    for (const p of pts) { arr.push(p.x, p.y); }
    this.state.terrainPoints = arr;
    // Debug: log once so we can verify in console
    console.log(`[RAF] terrainPoints length: ${this.state.terrainPoints.length}`);
    this.state.waterline = 560;
    // No server-side collision; terrain points are for clients only.

    // Client-authoritative position updates from the active player
    this.onMessage("activePos", (client, message: { x: number; y: number; creatureId?: string }) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      const activeId = this.state.activeCreatureId;
      if (!activeId) return;
      if (message.creatureId && message.creatureId !== activeId) return;
      const c = this.state.creatures.get(activeId);
      if (!c) return;
      c.x = message.x;
      c.y = message.y;
      // Basic server-side rule: drown check (optional authority)
      if (c.y > this.state.waterline + 10) {
        this.state.creatures.delete(activeId);
        this.advanceTurn();
      }
    });

    // Client-authoritative world state from active player (all creatures)
    this.onMessage("worldState", (client, message: { updates: Array<{ id: string; x: number; y: number }> }) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      if (!message || !Array.isArray(message.updates)) return;
      const toDelete: string[] = [];
      for (const u of message.updates) {
        const c = this.state.creatures.get(u.id);
        if (!c) continue;
        c.x = u.x;
        c.y = u.y;
        if (c.y > this.state.waterline + 10) toDelete.push(u.id);
      }
      for (const id of toDelete) {
        const wasActive = id === this.state.activeCreatureId;
        this.state.creatures.delete(id);
        if (wasActive) {
          this.advanceTurn();
        } else {
          this.checkWinCondition();
        }
      }
    });

    this.onMessage("kill", (client, { creatureId }: { creatureId: string }) => {
      const c = this.state.creatures.get(creatureId);
      if (!c) return;
      if (c.ownerSessionId !== client.sessionId && client.sessionId !== this.state.activePlayerSessionId) {
        // allow only owner or active player to report kill
        return;
      }
      this.state.creatures.delete(creatureId);
      if (this.state.activeCreatureId === creatureId) {
        this.advanceTurn();
      } else {
        this.checkWinCondition();
      }
    });

    this.onMessage("endTurn", (client) => {
      if (client.sessionId === this.state.activePlayerSessionId) {
        this.advanceTurn();
      }
    });

    this.setSimulationInterval((dt) => this.fixedTick(dt));
  }

  onJoin(client: Client) {
    if (!this.joinOrder.includes(client.sessionId)) this.joinOrder.push(client.sessionId);

    const color = this.colorForOwner(client.sessionId);
    for (let i = 0; i < 3; i++) {
      const c = new Creature();
      c.id = this.generateId();
      c.ownerSessionId = client.sessionId;
      c.radius = 16;
      c.color = color;
      const startX = 100 + Math.random() * (this.width - 200);
      const startY = 200 + Math.random() * 100;
      c.x = startX;
      c.y = startY;
      this.state.creatures.set(c.id, c);

      // No server-side body creation
    }

    if (!this.state.activePlayerSessionId) {
      this.state.activePlayerSessionId = client.sessionId;
      this.pickNextCreatureForPlayer(client.sessionId);
      this.turnEndsAt = Date.now() + this.turnDurationMs;
      this.state.turnRemainingMs = this.turnDurationMs;
    }
  }

  onLeave(client: Client) {
    // remove all creatures owned by this client
    [...this.state.creatures.values()] // spread to avoid iterating during delete
      .filter((c) => c.ownerSessionId === client.sessionId)
      .forEach((c) => {
        this.state.creatures.delete(c.id);
        // No server-side physics cleanup needed
      });

    this.joinOrder = this.joinOrder.filter((id) => id !== client.sessionId);
    this.lastCreatureIndexByPlayer.delete(client.sessionId);

    if (client.sessionId === this.state.activePlayerSessionId) {
      this.advanceTurn();
    } else {
      this.checkWinCondition();
    }
  }

  private fixedTick(_deltaTimeMs: number) {
    const now = Date.now();
    this.state.turnRemainingMs = Math.max(0, this.turnEndsAt - now);
    if (this.state.turnRemainingMs === 0 && this.state.activePlayerSessionId) {
      this.advanceTurn();
    }
  }

  private advanceTurn() {
    // Check win before advancing
    if (this.checkWinCondition()) return;

    const playersWithAlive = this.distinctOwnersWithAlive();
    if (playersWithAlive.length === 0) {
      this.state.activePlayerSessionId = "";
      this.state.activeCreatureId = "";
      this.state.turnRemainingMs = 0;
      return;
    }

    // move to next player in join order who has alive creatures
    const currentIdx = Math.max(0, playersWithAlive.indexOf(this.state.activePlayerSessionId));
    const nextPlayer = playersWithAlive[(currentIdx + 1) % playersWithAlive.length];
    this.state.activePlayerSessionId = nextPlayer;
    this.pickNextCreatureForPlayer(nextPlayer);
    this.turnEndsAt = Date.now() + this.turnDurationMs;
    this.state.turnRemainingMs = this.turnDurationMs;
  }

  private pickNextCreatureForPlayer(sessionId: string) {
    const all = [...this.state.creatures.values()].filter((c) => c.ownerSessionId === sessionId);
    if (all.length === 0) {
      this.state.activeCreatureId = "";
      return;
    }
    const lastIdx = this.lastCreatureIndexByPlayer.get(sessionId) ?? -1;
    // find next alive creature after lastIdx
    for (let i = 1; i <= all.length; i++) {
      const idx = (lastIdx + i) % all.length;
      const c = all[idx];
      if (c && this.state.creatures.has(c.id)) {
        this.state.activeCreatureId = c.id;
        this.lastCreatureIndexByPlayer.set(sessionId, idx);
        return;
      }
    }
    // fallback
    this.state.activeCreatureId = all[0].id;
    this.lastCreatureIndexByPlayer.set(sessionId, 0);
  }

  private distinctOwnersWithAlive(): string[] {
    const set = new Set<string>();
    for (const c of this.state.creatures.values()) set.add(c.ownerSessionId);
    // preserve join order
    return this.joinOrder.filter((id) => set.has(id));
  }

  private checkWinCondition(): boolean {
    const owners = this.distinctOwnersWithAlive();
    if (owners.length <= 1) {
      this.state.activePlayerSessionId = owners[0] || "";
      this.state.activeCreatureId = "";
      this.state.turnRemainingMs = 0;
      return true;
    }
    return false;
  }

  private generateId(length: number = 8) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < length; i++) s += chars[(Math.random() * chars.length) | 0];
    return s;
  }

  private colorForOwner(sessionId: string) {
    const palette = ["#2d8cf0", "#19be6b", "#ff9900", "#ed3f14", "#9a66e4", "#00bcd4", "#ff4081", "#00e5ff"];
    const idx = Math.max(0, this.joinOrder.indexOf(sessionId));
    return palette[idx % palette.length];
  }

  private generateIslandTop() {
    // Extended surface from -terrainHalfSpan to +terrainHalfSpan
    const water = this.state?.waterline ?? 560;
    const centerY = 360; // highland center above water
    const segments = 240; // more segments for long span
    const span = this.terrainHalfSpan * 2;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments; // 0..1 across span
      const x = -this.terrainHalfSpan + t * span;

      // edgeFactor: 0 at center, 1 at far edges
      const edgeFactor = Math.min(1, Math.abs(x) / this.terrainHalfSpan);

      // Baseline trends toward and then below waterline near edges
      // First term blends toward water, second term adds extra drop beneath water
      const towardWater = centerY + (water - centerY) * Math.pow(edgeFactor, 0.8);
      const extraDrop = Math.pow(edgeFactor, 1.5) * 180; // up to 180px below water at extreme
      let baseline = towardWater + extraDrop;

      // Organic noise (bumps)
      const n = Math.sin(t * Math.PI * 2) * 0.3 + Math.sin(t * Math.PI * 6 + 1.3) * 0.2 + Math.sin(t * Math.PI * 12 + 2.7) * 0.15;
      const y = baseline - n * 100; // vary around baseline
      pts.push({ x, y });
    }
    return pts;
  }

  private buildTerrainCollision(pts: { x: number; y: number }[]) {
    // Server doesn't build collisions; only clients need this.
  }
}
