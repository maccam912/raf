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

  // Input/physics are client-authoritative now; server tracks only state and turn.

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

    // Active client updates crate positions (authoritative for crate physics)
    this.onMessage("crateState", (client, message: { updates: Array<{ id: string; x: number; y: number }> }) => {
      if (client.sessionId !== this.state.activePlayerSessionId) return;
      if (!message || !Array.isArray(message.updates)) return;
      for (const u of message.updates) {
        const crate = this.state.crates.get(u.id);
        if (!crate) continue;
        crate.x = u.x;
        crate.y = u.y;
      }
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

  private fixedTick(_deltaTimeMs: number) {
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
      });
      // remove bookkeeping
      this.joinOrder = this.joinOrder.filter((id) => id !== sid);
      this.lastCreatureIndexByPlayer.delete(sid);
      this.state.playerNames.delete(sid);
      this.state.disconnectedUntil.delete(sid);
      if (sid === this.state.activePlayerSessionId) this.advanceTurn();
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
    // Server doesn't build collisions; only clients need this.
  }

  private isDisconnected(sessionId: string): boolean {
    const until = this.state.disconnectedUntil.get(sessionId);
    return typeof until === 'number' && until > Date.now();
  }

  private spawnCrate() {
    // Remove any existing crates
    const ids = Array.from(this.state.crates.keys());
    for (const id of ids) this.state.crates.delete(id);

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
  }

}
