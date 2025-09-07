import { Room, Client } from "colyseus";
import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import Matter from "matter-js";

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

  // Physics
  private engine = Matter.Engine.create({ gravity: { scale: 0.001, y: 1 } });
  private bodiesById: Map<string, Matter.Body> = new Map();
  private inputHeld: Map<string, { left: boolean; right: boolean }> = new Map();
  private pendingJump: Set<string> = new Set();
  private accumulator = 0; // ms accumulator for fixed sub-stepping

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
    this.buildTerrainCollision(pts);

    // Input is authoritative; apply on server to active creature
    this.onMessage("input", (client, message: { left?: boolean; right?: boolean }) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      const held = this.inputHeld.get(client.sessionId) ?? { left: false, right: false };
      this.inputHeld.set(client.sessionId, {
        left: !!message.left,
        right: !!message.right,
      });
    });

    this.onMessage("jump", (client) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      this.pendingJump.add(client.sessionId);
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

      const body = Matter.Bodies.circle(startX, startY, c.radius, { restitution: 0.35, friction: 0.8, frictionAir: 0.02 });
      this.bodiesById.set(c.id, body);
      Matter.World.add(this.engine.world, body);
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
        const b = this.bodiesById.get(c.id);
        if (b) {
          Matter.World.remove(this.engine.world, b);
          this.bodiesById.delete(c.id);
        }
      });

    this.joinOrder = this.joinOrder.filter((id) => id !== client.sessionId);
    this.lastCreatureIndexByPlayer.delete(client.sessionId);

    if (client.sessionId === this.state.activePlayerSessionId) {
      this.advanceTurn();
    } else {
      this.checkWinCondition();
    }
  }

  private fixedTick(deltaTimeMs: number) {
    const now = Date.now();
    this.state.turnRemainingMs = Math.max(0, this.turnEndsAt - now);
    if (this.state.turnRemainingMs === 0 && this.state.activePlayerSessionId) {
      this.advanceTurn();
    }

    // Apply input to active creature
    const activeOwner = this.state.activePlayerSessionId;
    const activeId = this.state.activeCreatureId;
    if (activeOwner && activeId) {
      const body = this.bodiesById.get(activeId);
      if (body) {
        const held = this.inputHeld.get(activeOwner) ?? { left: false, right: false };
        const forceX = (held.left ? -0.0015 : 0) + (held.right ? 0.0015 : 0);
        if (forceX !== 0) {
          Matter.Body.applyForce(body, body.position, { x: forceX, y: 0 });
        }
        if (this.pendingJump.has(activeOwner)) {
          this.pendingJump.delete(activeOwner);
          Matter.Body.applyForce(body, body.position, { x: 0, y: -0.03 });
        }
      }
    }

    // Sub-step to reduce tunneling
    const step = 16; // ~60Hz
    this.accumulator += Math.min(deltaTimeMs, 50);
    let steps = 0;
    while (this.accumulator >= step && steps < 5) {
      Matter.Engine.update(this.engine, step);
      this.accumulator -= step;
      steps++;
    }

    // Sync physics -> state, check drown (waterline)
    const toDelete: string[] = [];
    for (const [id, body] of this.bodiesById) {
      const c = this.state.creatures.get(id);
      if (!c) continue;
      c.x = body.position.x;
      c.y = body.position.y;

      if (c.y > this.state.waterline + 10) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      const c = this.state.creatures.get(id);
      if (c) {
        this.state.creatures.delete(id);
        const b = this.bodiesById.get(id);
        if (b) {
          Matter.World.remove(this.engine.world, b);
          this.bodiesById.delete(id);
        }
        if (this.state.activeCreatureId === id) {
          this.advanceTurn();
        } else {
          this.checkWinCondition();
        }
      }
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
    // Build a chain of static thin rectangles along the top surface for collision
    const parts: Matter.Body[] = [];
    const thickness = 20;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const angle = Math.atan2(dy, dx);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      // Offset the segment so that its top edge aligns with the surface line
      let nx = -dy / len;
      let ny = dx / len; // perpendicular to the segment
      if (ny < 0) { nx = -nx; ny = -ny; } // ensure normal points downward (into the land)
      const offX = nx * (thickness / 2);
      const offY = ny * (thickness / 2);
      const seg = Matter.Bodies.rectangle(cx + offX, cy + offY, len, thickness, { isStatic: true, angle, friction: 0.9, restitution: 0.1 });
      parts.push(seg);
    }
    Matter.World.add(this.engine.world, parts);
  }
}
