import { Room, Client } from "colyseus";
import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import Matter from "matter-js";
// Server authoritative physics using Matter.js. Clients send inputs; server simulates and broadcasts snapshots.

class Creature extends Schema {
  @type("string") id: string = "";
  @type("string") ownerSessionId: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") radius: number = 16;
  @type("string") color: string = "#2d8cf0";
  @type("number") hp: number = 100;
}

class Crate extends Schema {
  @type("string") id: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = -200;
  // weapon type in this crate (e.g., "grenade")
  @type("string") weapon: string = "grenade";
}

class RAFState extends Schema {
  @type({ map: Creature }) creatures = new MapSchema<Creature>();
  @type("string") activePlayerSessionId: string = "";
  @type("string") activeCreatureId: string = "";
  @type("number") turnRemainingMs: number = 0;
  @type(["number"]) terrainPoints = new ArraySchema<number>(); // flattened [x0,y0,x1,y1,...]
  @type("number") waterline: number = 560;
  @type({ map: "string" }) playerNames = new MapSchema<string>();
  @type({ map: "number" }) disconnectedUntil = new MapSchema<number>(); // sessionId -> epoch ms until grace expires
  @type("string") winnerSessionId: string = "";
  // Active weapon crates in the world
  @type({ map: Crate }) crates = new MapSchema<Crate>();
  // Player/team weapons by owner session id (e.g., "grenade" or "")
  @type({ map: "string" }) weaponsByPlayer = new MapSchema<string>();
}

type ImpulseMsg = { creatureId: string; fx: number; fy: number };
type StateMsg = { creatureId: string; x: number; y: number };

export class TurnBasedRAFRoom extends Room<RAFState> {
  maxClients = 8;

  private joinOrder: string[] = [];
  private lastCreatureIndexByPlayer: Map<string, number> = new Map();
  private turnDurationMs = 30_000;
  private turnEndsAt = 0;

  // Matter.js physics
  private engine = Matter.Engine.create();
  private world = this.engine.world;
  private creatureBodies: Map<string, Matter.Body> = new Map();
  private crateBodies: Map<string, Matter.Body> = new Map();
  private terrainBodies: Matter.Body[] = [];
  private snapshotIntervalMs = 50; // 20Hz snapshots
  private lastSnapshotAt = 0;

  // Latest input from active player
  private latestInput: { left?: boolean; right?: boolean; jump?: boolean } = {};
  private jumpQueued: boolean = false;

  private disconnectGraceMs = 300_000; // 5 minutes
  private createdOnJoinIds: Map<string, string[]> = new Map();

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
    // Build server-side terrain collisions
    const pairs: { x: number; y: number }[] = [];
    for (let i = 0; i < this.state.terrainPoints.length - 1; i += 2) {
      pairs.push({ x: this.state.terrainPoints[i], y: this.state.terrainPoints[i + 1] });
    }
    this.buildTerrainCollision(pairs);

    // Input from active player (20Hz from client) — continuous axes only
    this.onMessage("input", (client, message: { left?: boolean; right?: boolean; jump?: boolean }) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      this.latestInput = {
        left: !!message?.left,
        right: !!message?.right,
        // jump is handled via a discrete message; ignore here to avoid edge-loss
        jump: false,
      };
    });

    // Discrete jump action from active player (edge-triggered)
    this.onMessage("jump", (client) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      this.jumpQueued = true;
    });

    // Pickup crate -> grant weapon to that player's team
    this.onMessage("pickupCrate", (client, message: { crateId: string; bySessionId: string }) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      const { crateId, bySessionId } = message || ({} as any);
      if (!crateId || !bySessionId) return;
      const crate = this.state.crates.get(crateId);
      if (!crate) return;
      // grant weapon (overwrite existing for simplicity)
      this.state.weaponsByPlayer.set(bySessionId, crate.weapon || "grenade");
      this.state.crates.delete(crateId);
      // remove server physics body for crate
      const body = this.crateBodies.get(crateId);
      if (body) {
        try { Matter.Composite.remove(this.world, body); } catch {}
        this.crateBodies.delete(crateId);
      }
    });

    // Consume current player's weapon (e.g., when grenade is dropped)
    this.onMessage("consumeWeapon", (client) => {
      const sid = client.sessionId;
      const current = this.state.weaponsByPlayer.get(sid);
      if (!current) return;
      this.state.weaponsByPlayer.delete(sid);
      // Enter retreat mode: exactly 5s to retreat from the moment of weapon use
      const now = Date.now();
      this.turnEndsAt = now + 5000;
      this.state.turnRemainingMs = 5000;
    });

    // Apply damage to creatures (from active client explosion events)
    this.onMessage("applyDamage", (client, message: { hits: Array<{ id: string; dmg: number }> }) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      if (!message || !Array.isArray(message.hits)) return;
      const toDelete: string[] = [];
      for (const h of message.hits) {
        const c = this.state.creatures.get(h.id);
        if (!c) continue;
        const dmg = Math.max(0, Math.min(200, Number(h.dmg) || 0));
        c.hp = Math.max(0, (c.hp ?? 100) - dmg);
        if (c.hp <= 0) toDelete.push(c.id);
      }
      for (const id of toDelete) {
        const wasActive = id === this.state.activeCreatureId;
        this.state.creatures.delete(id);
        this.removeCreatureBody(id);
        if (wasActive) {
          this.advanceTurn();
        } else {
          this.checkWinCondition();
        }
      }
    });

    // Allow a newly joined player to take over a disconnected player's slot and creatures
    this.onMessage("takeover", (client, message: { targetSessionId: string }) => {
      const target = message?.targetSessionId;
      if (!target || target === client.sessionId) return;
      const until = this.state.disconnectedUntil.get(target);
      if (typeof until !== 'number' || until <= Date.now()) return; // only allow takeover of currently disconnected-within-grace

      // Remove creatures created for the joiner at entry
      const mine = this.createdOnJoinIds.get(client.sessionId) || [];
      for (const id of mine) {
        this.state.creatures.delete(id);
      }
      this.createdOnJoinIds.delete(client.sessionId);

      // Transfer creatures from target to client
      for (const c of this.state.creatures.values()) {
        if (c.ownerSessionId === target) c.ownerSessionId = client.sessionId;
      }

      // Replace target with client in turn order
      const idx = this.joinOrder.indexOf(target);
      if (idx >= 0) this.joinOrder[idx] = client.sessionId;
      // Remove any duplicate of client's id elsewhere in joinOrder
      this.joinOrder = this.joinOrder.filter((sid, i) => i === idx || sid !== client.sessionId);

      // Transfer last-creature index tracking
      const lastIdx = this.lastCreatureIndexByPlayer.get(target);
      if (typeof lastIdx === 'number') {
        this.lastCreatureIndexByPlayer.set(client.sessionId, lastIdx);
      }
      this.lastCreatureIndexByPlayer.delete(target);

      // If target was active, hand over control
      if (this.state.activePlayerSessionId === target) {
        this.state.activePlayerSessionId = client.sessionId;
      }

      // Remove target bookkeeping
      this.state.playerNames.delete(target);
      this.state.disconnectedUntil.delete(target);
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

    this.world.gravity.y = 1;
    this.engine.positionIterations = 8;
    this.engine.velocityIterations = 8;
    this.engine.constraintIterations = 2;

    this.setSimulationInterval((dt) => this.fixedTick(dt));
  }

  onJoin(client: Client, options: any) {
    if (!this.joinOrder.includes(client.sessionId)) this.joinOrder.push(client.sessionId);

    const color = this.colorForOwner(client.sessionId);
    // Name handling
    let name: string = (options?.name ?? "").toString().trim();
    if (!name) name = `Player-${this.generateId(4)}`;
    // Truncate to reasonable length and strip newlines
    name = name.replace(/\s+/g, " ").slice(0, 24);
    this.state.playerNames.set(client.sessionId, name);

    for (let i = 0; i < 3; i++) {
      const c = new Creature();
      c.id = this.generateId();
      c.ownerSessionId = client.sessionId;
      c.radius = 16;
      c.color = color;
      c.hp = 100;
      const startX = 100 + Math.random() * (this.width - 200);
      const startY = 200 + Math.random() * 100;
      c.x = startX;
      c.y = startY;
      this.state.creatures.set(c.id, c);
      this.createCreatureBody(c);
      const created = this.createdOnJoinIds.get(client.sessionId) ?? [];
      created.push(c.id);
      this.createdOnJoinIds.set(client.sessionId, created);
    }

    if (!this.state.activePlayerSessionId) {
      this.state.activePlayerSessionId = client.sessionId;
      this.pickNextCreatureForPlayer(client.sessionId);
      this.turnEndsAt = Date.now() + this.turnDurationMs;
      this.state.turnRemainingMs = this.turnDurationMs;
      // Spawn a weapon crate for the first turn
      this.spawnCrate();
    }
  }

  onLeave(client: Client) {
    this.joinOrder = this.joinOrder.filter((id) => id !== client.sessionId);
    this.lastCreatureIndexByPlayer.delete(client.sessionId);
    // mark disconnected with grace period
    const until = Date.now() + this.disconnectGraceMs;
    this.state.disconnectedUntil.set(client.sessionId, until);
    // If exactly two owners remain alive, and one disconnects, declare immediate win to the other.
    const owners = this.distinctOwnersWithAlive();
    if (owners.length === 2) {
      const other = owners.find((id) => id !== client.sessionId);
      if (other) {
        this.state.winnerSessionId = other;
        this.state.activePlayerSessionId = "";
        this.state.activeCreatureId = "";
        this.state.turnRemainingMs = 0;
        return;
      }
    }

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

    // Skip turn immediately if the active player is disconnected (in grace)
    const active = this.state.activePlayerSessionId;
    if (active && this.isDisconnected(active)) {
      this.advanceTurn();
    }

    // Expire disconnected players past grace: remove them and their creatures
    const expired: string[] = [];
    for (const [sid, until] of this.state.disconnectedUntil) {
      if (now >= until) expired.push(sid);
    }
    for (const sid of expired) {
      // remove creatures
      [...this.state.creatures.values()].forEach((c) => {
        if (c.ownerSessionId === sid) this.state.creatures.delete(c.id);
        if (c.ownerSessionId === sid) this.removeCreatureBody(c.id);
      });
      // remove bookkeeping
      this.joinOrder = this.joinOrder.filter((id) => id !== sid);
      this.lastCreatureIndexByPlayer.delete(sid);
      this.state.playerNames.delete(sid);
      this.state.disconnectedUntil.delete(sid);
      if (sid === this.state.activePlayerSessionId) this.advanceTurn();
    }

    // Apply latest input forces to active creature
    const activeId = this.state.activeCreatureId;
    if (activeId) {
      const body = this.creatureBodies.get(activeId);
      if (body) {
        const forceX = (this.latestInput.left ? -0.0015 : 0) + (this.latestInput.right ? 0.0015 : 0);
        if (forceX !== 0) {
          Matter.Body.applyForce(body, body.position, { x: forceX, y: 0 });
        }
        // Apply queued jump impulse once
        if (this.jumpQueued) {
          Matter.Body.applyForce(body, body.position, { x: 0, y: -0.03 });
          this.jumpQueued = false;
        }
      }
    }

    // Step physics
    Matter.Engine.update(this.engine, deltaTimeMs);

    // Mirror physics positions into schema for general visibility
    for (const [id, body] of this.creatureBodies) {
      const c = this.state.creatures.get(id);
      if (!c) continue;
      c.x = body.position.x;
      c.y = body.position.y;
    }

    // Drown check and removals
    const toDelete: string[] = [];
    for (const [id, body] of this.creatureBodies) {
      if (body.position.y > this.state.waterline + 10) toDelete.push(id);
    }
    for (const id of toDelete) {
      const wasActive = id === this.state.activeCreatureId;
      this.state.creatures.delete(id);
      this.removeCreatureBody(id);
      if (wasActive) this.advanceTurn();
    }

    // Broadcast periodic snapshot (pos + velocity)
    if (now - this.lastSnapshotAt >= this.snapshotIntervalMs) {
      const objects: Array<{ id: string; x: number; y: number; vx: number; vy: number; type: string }> = [];
      for (const [id, body] of this.creatureBodies) {
        objects.push({ id, x: body.position.x, y: body.position.y, vx: body.velocity.x, vy: body.velocity.y, type: "creature" });
      }
      for (const [id, body] of this.crateBodies) {
        objects.push({ id, x: body.position.x, y: body.position.y, vx: body.velocity.x, vy: body.velocity.y, type: "crate" });
      }
      this.broadcast("snapshot", { objects });
      this.lastSnapshotAt = now;
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
    for (let step = 1; step <= playersWithAlive.length; step++) {
      const cand = playersWithAlive[(currentIdx + step) % playersWithAlive.length];
      if (!this.isDisconnected(cand)) {
        this.state.activePlayerSessionId = cand;
        this.pickNextCreatureForPlayer(cand);
        this.turnEndsAt = Date.now() + this.turnDurationMs;
        this.state.turnRemainingMs = this.turnDurationMs;
        // New turn -> new crate
        this.spawnCrate();
        return;
      }
    }
    // No connected players with alive creatures
    this.state.activePlayerSessionId = "";
    this.state.activeCreatureId = "";
    this.state.turnRemainingMs = 0;
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
      const winner = owners[0] || "";
      this.state.winnerSessionId = winner;
      this.state.activePlayerSessionId = "";
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
    try {
      // Remove prior terrain bodies
      for (const b of this.terrainBodies) Matter.Composite.remove(this.world, b);
      this.terrainBodies = [];
      if (!pts || pts.length < 2) return;
      const thickness = 20;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const angle = Math.atan2(dy, dx);
        let nx = -dy / len;
        let ny = dx / len;
        if (ny < 0) { nx = -nx; ny = -ny; }
        const offX = nx * (thickness / 2);
        const offY = ny * (thickness / 2);
        const cx = (a.x + b.x) / 2 + offX;
        const cy = (a.y + b.y) / 2 + offY;
        const seg = Matter.Bodies.rectangle(cx, cy, len, thickness, { isStatic: true, angle, friction: 0.9, restitution: 0.1 });
        this.terrainBodies.push(seg);
      }
      Matter.Composite.add(this.world, this.terrainBodies);
    } catch (e) {
      console.error("Failed to build terrain bodies:", e);
    }
  }

  private createCreatureBody(c: Creature) {
    const body = Matter.Bodies.circle(c.x, c.y, c.radius, {
      restitution: 0.9,
      friction: 0.05,
      frictionAir: 0.02,
      density: 0.001,
    });
    (body as any).__id = c.id;
    this.creatureBodies.set(c.id, body);
    Matter.Composite.add(this.world, body);
  }

  private removeCreatureBody(id: string) {
    const body = this.creatureBodies.get(id);
    if (body) {
      try { Matter.Composite.remove(this.world, body); } catch {}
    }
    this.creatureBodies.delete(id);
  }

  private isDisconnected(sessionId: string): boolean {
    const until = this.state.disconnectedUntil.get(sessionId);
    return typeof until === 'number' && until > Date.now();
  }

  private spawnCrate() {
    // Remove any existing crates (state + physics)
    const ids = Array.from(this.state.crates.keys());
    for (const id of ids) {
      this.state.crates.delete(id);
      const body = this.crateBodies.get(id);
      if (body) {
        try { Matter.Composite.remove(this.world, body); } catch {}
        this.crateBodies.delete(id);
      }
    }

    // Pick a random x over dry land (y above waterline)
    const tp = this.state.terrainPoints;
    if (!tp || tp.length < 4) return;
    const pairs: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < tp.length - 1; i += 2) pairs.push({ x: tp[i], y: tp[i + 1] });
    const dry = pairs.filter((p) => p.y < this.state.waterline - 10);
    const pick = dry.length > 0 ? dry[(Math.random() * dry.length) | 0] : pairs[(Math.random() * pairs.length) | 0];
    const crate = new Crate();
    crate.id = `crate_${this.generateId(6)}`;
    crate.weapon = "grenade";
    crate.x = pick.x;
    crate.y = -200;
    this.state.crates.set(crate.id, crate);

    // Create server-side physics body for the crate
    const body = Matter.Bodies.rectangle(crate.x, crate.y, 14, 14, {
      restitution: 0.2,
      friction: 0.6,
      frictionStatic: 0.8,
      frictionAir: 0.01,
    });
    (body as any).__id = crate.id;
    this.crateBodies.set(crate.id, body);
    Matter.Composite.add(this.world, body);
  }

}
