import Phaser from "phaser";
import { Client, Room } from "colyseus.js";

type Creature = { id: string; ownerSessionId: string; x: number; y: number; radius: number; color: string; hp?: number };
type Crate = { id: string; x: number; y: number; weapon: string };
type RoomState = {
  creatures: Map<string, Creature> | Record<string, Creature>;
  activePlayerSessionId: string;
  activeCreatureId: string;
  turnRemainingMs: number;
  waterline?: number;
  crates?: Map<string, Crate> | Record<string, Crate>;
  weaponsByPlayer?: Map<string, string> | Record<string, string>;
};

class GameScene extends Phaser.Scene {
  private client!: Client;
  private room!: Room<RoomState>;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { up: Phaser.Input.Keyboard.Key; down: Phaser.Input.Keyboard.Key; left: Phaser.Input.Keyboard.Key; right: Phaser.Input.Keyboard.Key };
  private space!: Phaser.Input.Keyboard.Key;
  private keyEnter!: Phaser.Input.Keyboard.Key;

  private creatureGraphics: Record<string, Phaser.GameObjects.Arc> = {};
  private creatureBodies: Record<string, any> = {};
  private crateGraphics: Record<string, Phaser.GameObjects.Rectangle> = {};
  private crateBodies: Record<string, any> = {};
  private grenade: { id: string; body?: any; gfx?: Phaser.GameObjects.Arc; explodeAt: number } | null = null;
  private terrainBodies: any[] = [];
  private lastServerPos: Record<string, { x: number; y: number }> = {};
  private lastServerTime: Record<string, number> = {};
  private lastAutoResyncAt: Record<string, number> = {};
  private localActiveId: string | null = null;
  private lastSent = 0;
  private jumpHeldPrev = false;

  private width = 800;
  private height = 600;
  private waterline = 560; // y > waterline = water
  private terrainDrawn = false;
  private terrainGraphics?: Phaser.GameObjects.Graphics;
  private waterRect?: Phaser.GameObjects.Rectangle;
  private skyRect?: Phaser.GameObjects.Rectangle;
  private followEnabled = true;
  private lastFollowId: string | null = null;
  private keyFollowToggle!: Phaser.Input.Keyboard.Key;
  private keyZoomIn!: Phaser.Input.Keyboard.Key;
  private keyZoomOut!: Phaser.Input.Keyboard.Key;
  private keyResync!: Phaser.Input.Keyboard.Key;
  private dragLast?: Phaser.Math.Vector2;
  private terrainSource: 'unknown' | 'server' | 'client' = 'unknown';
  private posSmoothingTau = 120; // ms time-constant for position smoothing
  private resyncThreshold = 24; // px divergence before snapping to server
  private autoResyncIntervalMs = 0; // resync as often as server updates
  private velocityScale = 0.02; // scale server-estimated velocity for local client feel
  private explosionRadius = 160;
  private explosionForce = 0.12; // stronger blast so creatures visibly fly
  private spriteLerpTau = 16; // ms time-constant for visual-only smoothing (5x faster)

  constructor() {
    super("game");
  }

  preload() {}

  async create() {
    this.cameras.main.setBackgroundColor(0x1f2630);
    // Sky background covering a huge world area (static, no per-frame resize)
    this.skyRect = this.add
      .rectangle(-100000, -100000, 200000, 200000, 0x0e1013)
      .setOrigin(0, 0)
      .setDepth(-2);

    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = {
      up: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D)
    };
    this.space = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.keyEnter = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);

    (document.getElementById("status")!).textContent = "Connecting to server...";
    // Ask for player name (store in localStorage)
    const defaultName = localStorage.getItem('playerName') || `Player-${(Math.random()*1000)|0}`;
    const inputName = (typeof window !== 'undefined' ? window.prompt('Enter your name', defaultName) : defaultName) || defaultName;
    const name = inputName.trim().slice(0, 24) || defaultName;
    localStorage.setItem('playerName', name);
    this.client = new Client("ws://localhost:2567");
    this.room = await this.client.joinOrCreate<RoomState>("rebate_attack_force", { name });
    (document.getElementById("status")!).textContent = `Connected. Your session: ${this.room.sessionId}`;

    // If there are disconnected players, offer takeover
    setTimeout(() => this.offerTakeoverIfAvailable(), 100); // slight delay to ensure state arrives

    // Camera controls
    this.keyFollowToggle = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F);
    this.keyZoomIn = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.X);
    this.keyZoomOut = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
    this.keyResync = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R);
    // Very large world bounds to allow free camera panning
    this.cameras.main.setBounds(-100000, -100000, 200000, 200000);
    this.cameras.main.setDeadzone(160, 120);
    this.input.on('wheel', (_p: any, _g: any, _dx: number, dy: number) => {
      const factor = dy > 0 ? 0.9 : 1/0.9;
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom * factor, 0.5, 2));
    });

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.dragLast = new Phaser.Math.Vector2(p.x, p.y);
    });
    this.input.on('pointerup', () => { this.dragLast = undefined; });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.followEnabled && p.isDown && this.dragLast) {
        const dx = (p.x - this.dragLast.x) / this.cameras.main.zoom;
        const dy = (p.y - this.dragLast.y) / this.cameras.main.zoom;
        this.cameras.main.scrollX -= dx;
        this.cameras.main.scrollY -= dy;
        this.dragLast.set(p.x, p.y);
      }
    });

    // Tweak Matter.js solver for snappier collisions
    const engine: any = (this.matter.world as any).engine;
    if (engine) {
      engine.positionIterations = 8;
      engine.velocityIterations = 8;
      engine.constraintIterations = 2;
    }

    // Listen for server snapshots (positions + velocities)
    this.room.onMessage("snapshot", (msg: any) => {
      const objs: Array<{ id: string; x: number; y: number; vx: number; vy: number; type: string }> = msg?.objects || [];
      const MatterBody = (Phaser.Physics.Matter as any).Matter.Body;
      const nowT = Date.now();
      for (const o of objs) {
        const stateAny: any = this.room?.state as any;
        if (o.type === 'creature') {
          // ensure creature body exists
          const pool: any = stateAny?.creatures || {};
          const getC = typeof pool.get === 'function' ? pool.get.bind(pool) : (id: string) => pool[id];
          const c = getC(o.id) as Creature | undefined;
          if (!c) continue;
          let body = this.creatureBodies[o.id];
          if (!body) {
            body = this.matter.add.circle(c.x, c.y, c.radius, {
              restitution: 0.9,
              friction: 0.05,
              frictionAir: 0.02,
              density: 0.001,
            });
            (body as any).__ent = { type: 'creature', id: o.id };
            this.creatureBodies[o.id] = body;
          }
          // direct snap to authoritative state (no smoothing)
          MatterBody.setPosition(body, { x: o.x, y: o.y });
          MatterBody.setVelocity(body, { x: o.vx, y: o.vy });
          // record last server position/time
          this.lastServerPos[o.id] = { x: o.x, y: o.y };
          this.lastServerTime[o.id] = nowT;
        } else if (o.type === 'crate') {
          // ensure crate body exists
          const cratesAny: any = stateAny?.crates || {};
          const getCr = typeof cratesAny.get === 'function' ? cratesAny.get.bind(cratesAny) : (id: string) => cratesAny[id];
          const cr = getCr(o.id) as Crate | undefined;
          if (!cr) continue;
          let body = this.crateBodies[o.id];
          if (!body) {
            body = this.matter.add.rectangle(cr.x, cr.y, 14, 14, {
              restitution: 0.2,
              friction: 0.6,
              frictionStatic: 0.8,
              frictionAir: 0.01,
            });
            (body as any).__ent = { type: 'crate', id: o.id };
            this.crateBodies[o.id] = body;
          }
          // direct snap to authoritative state
          MatterBody.setPosition(body, { x: o.x, y: o.y });
          MatterBody.setVelocity(body, { x: o.vx, y: o.vy });
          // visual sprite blends toward body in update()
        }
      }
    });

    // Global collision handler for crate pickup
    (this.matter.world as any).on('collisionstart', (event: any) => {
      const pairs = event.pairs || [];
      for (const p of pairs) {
        const a = p.bodyA;
        const b = p.bodyB;
        const infoA = (a as any).__ent as { type: string; id: string } | undefined;
        const infoB = (b as any).__ent as { type: string; id: string } | undefined;
        if (!infoA || !infoB) continue;
        // crate vs creature -> pickup
        let crateInfo: any, creatureInfo: any;
        if (infoA.type === 'crate' && infoB.type === 'creature') { crateInfo = infoA; creatureInfo = infoB; }
        else if (infoB.type === 'crate' && infoA.type === 'creature') { crateInfo = infoB; creatureInfo = infoA; }
        if (crateInfo && creatureInfo) {
          const stateAny: any = this.room?.state as any;
          const creatures: any = stateAny?.creatures || {};
          const getC = typeof creatures.get === 'function' ? creatures.get.bind(creatures) : (id: string) => creatures[id];
          const c = getC(creatureInfo.id) as Creature | undefined;
          if (!c) continue;
          // Award to creature owner's team
          this.room?.send('pickupCrate', { crateId: crateInfo.id, bySessionId: c.ownerSessionId });
          // Remove crate locally
          const body = this.crateBodies[crateInfo.id];
          if (body) { try { this.matter.world.remove(body); } catch {} }
          this.crateBodies[crateInfo.id] = undefined as any;
          const gfx = this.crateGraphics[crateInfo.id];
          if (gfx) gfx.destroy();
          delete this.crateGraphics[crateInfo.id];
        }
      }
    });
  }

  update(time: number, delta: number) {
    if (!this.room) return;

    // Draw terrain lazily once it's available from server state
    const stateAny = this.room.state as any;
    const tp = (stateAny as any).terrainPoints;
    const hasServerTP = tp && typeof tp.length === 'number' && tp.length >= 4;
    if (!this.terrainDrawn && hasServerTP) {
      this.drawTerrain();
      this.terrainDrawn = true;
    }

    // Ensure local entities reflect server state (create/destroy)
    const seen = new Set<string>();
    const creatures: any = stateAny?.creatures;
    if (creatures) {
      const forEach = typeof creatures.forEach === "function"
        ? creatures.forEach.bind(creatures)
        : (cb: Function) => Object.keys(creatures).forEach((id) => cb(creatures[id], id));

      const activeId = stateAny.activeCreatureId as string;
      forEach((c: Creature, id: string) => {
        seen.add(id);
        let gfx = this.creatureGraphics[id];
        if (!gfx) {
          gfx = this.add.circle(c.x, c.y, c.radius, Number(c.color.replace("#", "0x"))).setDepth(3);
          this.creatureGraphics[id] = gfx;
        }
        // Ensure local physics body exists on all clients and use it to drive visuals
        let body = this.creatureBodies[id];
        if (!body) {
          body = this.matter.add.circle(c.x, c.y, c.radius, {
            restitution: 0.9,
            friction: 0.05,
            frictionAir: 0.02,
            density: 0.001,
          });
          (body as any).__ent = { type: 'creature', id };
          this.creatureBodies[id] = body;
        }
        // Visual smoothing towards authoritative body position
        const alpha = 1 - Math.exp(-delta / Math.max(1, this.spriteLerpTau));
        gfx.x += (body.position.x - gfx.x) * alpha;
        gfx.y += (body.position.y - gfx.y) * alpha;

        // Bookkeeping can be simplified now that server is authoritative via snapshots
      });
    }

    // Crates
    const seenCrates = new Set<string>();
    const crates: any = stateAny?.crates;
    if (crates) {
      const forEachCrate = typeof crates.forEach === 'function'
        ? crates.forEach.bind(crates)
        : (cb: Function) => Object.keys(crates).forEach((id) => cb(crates[id], id));
      forEachCrate((cr: Crate, id: string) => {
        seenCrates.add(id);
        // ensure gfx exists
        let gfx = this.crateGraphics[id];
        if (!gfx) {
          gfx = this.add.rectangle(cr.x, cr.y, 14, 14, 0xffe066).setStrokeStyle(2, 0x8d6e00).setDepth(2);
          this.crateGraphics[id] = gfx;
        }
        // ensure body exists (may be created from snapshot; if not, create at state pos)
        let body = this.crateBodies[id];
        if (!body) {
          body = this.matter.add.rectangle(cr.x, cr.y, 14, 14, {
            restitution: 0.2,
            friction: 0.6,
            frictionStatic: 0.8,
            frictionAir: 0.01,
          });
          (body as any).__ent = { type: 'crate', id };
          this.crateBodies[id] = body;
        }
        // Visual smoothing towards body position
        const alpha = 1 - Math.exp(-delta / Math.max(1, this.spriteLerpTau));
        gfx.x += ((body as any).position.x - gfx.x) * alpha;
        gfx.y += ((body as any).position.y - gfx.y) * alpha;
      });
    }
    // Cleanup crates removed from state
    Object.keys(this.crateGraphics).forEach((id) => {
      if (!seenCrates.has(id)) {
        this.crateGraphics[id]?.destroy();
        delete this.crateGraphics[id];
        if (this.crateBodies[id]) {
          try { this.matter.world.remove(this.crateBodies[id]); } catch {}
          delete this.crateBodies[id];
        }
      }
    });

    // Remove entities that no longer exist on server
    Object.keys(this.creatureGraphics).forEach((id) => {
      if (!seen.has(id)) {
        this.creatureGraphics[id]?.destroy();
        delete this.creatureGraphics[id];
        if (this.creatureBodies[id]) {
          try { this.matter.world.remove(this.creatureBodies[id]); } catch {}
          delete this.creatureBodies[id];
          if (this.localActiveId === id) this.localActiveId = null;
        }
      }
    });

    // Control only on our active creature; send inputs to server at 20Hz and predict locally
    const isMyTurn = this.room.sessionId === (stateAny).activePlayerSessionId;
    const activeId = (stateAny).activeCreatureId as string;
    if (isMyTurn && activeId) {
      const left = this.cursors.left.isDown || this.wasd.left.isDown;
      const right = this.cursors.right.isDown || this.wasd.right.isDown;
      const upNow = this.cursors.up.isDown || this.wasd.up.isDown;
      const justJump = upNow && !this.jumpHeldPrev;
      this.jumpHeldPrev = upNow;

      if (!this.grenade && Phaser.Input.Keyboard.JustDown(this.space)) {
        this.room.send("endTurn");
      }

      // Discrete Enter: use current weapon (e.g., drop grenade)
      if (Phaser.Input.Keyboard.JustDown(this.keyEnter)) {
        const weapon = this.getWeaponForMe();
        if (!this.grenade && weapon === 'grenade') {
          // Spawn a simple grenade body positioned beneath the creature to avoid overlap ejection
          const activeBody = this.creatureBodies[activeId];
          if (activeBody) {
            // Determine a spawn point outside the creature radius, directly beneath
            const stateAny2: any = this.room?.state as any;
            const pool: any = stateAny2?.creatures || {};
            const getC = typeof pool.get === 'function' ? pool.get.bind(pool) : (id: string) => pool[id];
            const c: any = getC(activeId) || {};
            const rCreature = Number(c.radius) || 16;
            const rGrenade = 6;
            const margin = 4;
            const dist = rCreature + rGrenade + margin;
            const baseX = (activeBody as any).position.x;
            const baseY = (activeBody as any).position.y;
            const px = baseX;
            const py = baseY + dist; // below the creature

            const body = this.matter.add.circle(px, py, rGrenade, {
              restitution: 0.3,
              friction: 0.3,
              frictionAir: 0.005,
              density: 0.0008,
            });
            const gfx = this.add.circle(px, py, rGrenade, 0x888888).setDepth(3);
            // No initial upward impulse; let gravity settle it. Minimal horizontal carry-over from creature.
            const MatterBody = (Phaser.Physics.Matter as any).Matter.Body;
            const carryVx = (activeBody as any).velocity?.x ?? 0;
            MatterBody.setVelocity(body, { x: carryVx * 0.25, y: 0 });
            this.grenade = { id: 'gren', body, gfx, explodeAt: Date.now() + 2000 };
            // Inform server we consumed weapon -> triggers retreat timer
            this.room.send('consumeWeapon');
          }
        }
      }

      // Edge-triggered actions: send immediately to avoid being dropped by 20Hz sampler
      if (justJump) {
        this.room.send("jump");
      }

      // Local prediction: apply forces to the active creature body
      const body = this.creatureBodies[activeId];
      if (body) {
        const MatterBody = (Phaser.Physics.Matter as any).Matter.Body;
        const forceX = (left ? -0.0015 : 0) + (right ? 0.0015 : 0);
        if (forceX !== 0) MatterBody.applyForce(body, body.position, { x: forceX, y: 0 });
        if (justJump) MatterBody.applyForce(body, body.position, { x: 0, y: -0.03 });
      }

      // Sample and send inputs just before snapshot cadence (~20Hz)
      if (time - this.lastSent >= 50) {
        // Only continuous axes here; discrete jump is sent immediately
        this.room.send("input", { left, right });
        this.lastSent = time;
      }
    }

    // Highlight active creature
    Object.entries(this.creatureGraphics).forEach(([id, gfx]) => {
      const isActive = id === activeId;
      gfx.setStrokeStyle(isActive ? 4 : 1, isActive ? 0xffff00 : 0x111111);
    });

    // Sync grenade visuals to physics body each frame
    if (this.grenade && this.grenade.body && this.grenade.gfx) {
      const p = (this.grenade.body as any).position;
      this.grenade.gfx.x = p.x;
      this.grenade.gfx.y = p.y;
    }

    // Backdrop is static (no per-frame resizing for performance)

    // UI updates
    const namesMap: any = (stateAny as any).playerNames || {};
    const activeName = (namesMap?.get?.(stateAny.activePlayerSessionId)) ?? namesMap?.[stateAny.activePlayerSessionId] ?? stateAny.activePlayerSessionId ?? '';
    (document.getElementById("turn")!).textContent = `Up: ${activeName || '—'}`;
    const secs = Math.ceil((((stateAny).turnRemainingMs || 0) as number) / 1000);
    (document.getElementById("timer")!).textContent = `Turn ends in: ${secs}s`;
    // Winner overlay
    const winnerId = (stateAny as any).winnerSessionId as string;
    const winnerEl = document.getElementById('winner');
    if (winnerEl) {
      if (winnerId && winnerId.length > 0) {
        const wname = (namesMap?.get?.(winnerId)) ?? namesMap?.[winnerId] ?? winnerId;
        winnerEl.textContent = `${wname} wins!`;
        (winnerEl as any).style.display = 'block';
      } else {
        (winnerEl as any).style.display = 'none';
      }
    }

    // Scoreboard: sum actual HP per player (sum of each creature's HP)
    const hpByOwner = new Map<string, number>();
    const forEachC = typeof creatures?.forEach === 'function'
      ? creatures.forEach.bind(creatures)
      : (cb: Function) => Object.keys(creatures||{}).forEach((id) => cb((creatures as any)[id], id));
    if (creatures) {
      forEachC((c: Creature) => {
        const cur = hpByOwner.get(c.ownerSessionId) || 0;
        const hp = (c as any).hp ?? 100;
        hpByOwner.set(c.ownerSessionId, cur + Number(hp));
      });
    }
    // Build display list of players from names map (fallback to any owner seen)
    const entries: Array<{ id: string; name: string; hp: number; active: boolean; dc: boolean }> = [];
    const addEntry = (id: string) => {
      const nm = (namesMap?.get?.(id)) ?? namesMap?.[id] ?? id;
      const dcMap: any = (stateAny as any).disconnectedUntil || {};
      let until = 0;
      if (typeof dcMap.forEach === 'function') { dcMap.forEach((v: number, key: string) => { if (key === id) until = v; }); }
      else { until = dcMap?.[id] ?? 0; }
      const dc = typeof until === 'number' && until > Date.now();
      entries.push({ id, name: nm, hp: hpByOwner.get(id) || 0, active: id === stateAny.activePlayerSessionId, dc });
    };
    if (namesMap) {
      if (typeof namesMap.forEach === 'function') {
        namesMap.forEach((_v: string, key: string) => addEntry(key));
      } else {
        Object.keys(namesMap).forEach(addEntry);
      }
    } else {
      // fallback: derive from owners present in creatures
      const owners = new Set<string>();
      const forEachC2 = forEachC;
      if (creatures) forEachC2((c: Creature) => owners.add(c.ownerSessionId));
      owners.forEach(addEntry);
    }
    // Sort: active first, then by name
    entries.sort((a, b) => (b.active?1:0)-(a.active?1:0) || a.name.localeCompare(b.name));
    const sb = document.getElementById('scoreboard');
    if (sb) {
      sb.innerHTML = entries.map(e => `${e.active ? '▶ ' : ''}${e.name}${e.dc ? ' (DC)' : ''}: ${e.hp} HP`).join('<br>');
    }

    // Debug overlay
    const tpObj = (stateAny as any).terrainPoints;
    const tpLen = tpObj && typeof tpObj.length === 'number' ? tpObj.length : 0;
    const debug = document.getElementById('debug');
    if (debug) {
      debug.textContent = `terrainPoints=${tpLen} source=${this.terrainSource} drawn=${this.terrainDrawn} creatures=${seen.size} follow=${this.followEnabled} zoom=${this.cameras.main.zoom.toFixed(2)} active=${activeId ?? ''}`;
    }

    // Camera follow / zoom
    // Grenade explosion timing and cleanup across turn change
    if (this.room.sessionId === (stateAny).activePlayerSessionId) {
      this.maybeExplodeGrenade();
    } else if (this.grenade) {
      try { if (this.grenade.body) this.matter.world.remove(this.grenade.body); } catch {}
      if (this.grenade.gfx) this.grenade.gfx.destroy();
      this.grenade = null;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyFollowToggle)) {
      this.followEnabled = !this.followEnabled;
      if (!this.followEnabled) this.cameras.main.stopFollow();
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyResync)) {
      this.followEnabled = true;
      this.lastFollowId = null; // force reattach
      // Force snap local body to latest server state if available
      const activeId2 = (stateAny).activeCreatureId as string;
      const creatureMap: any = (stateAny as any).creatures;
      const c = creatureMap?.get?.(activeId2) ?? creatureMap?.[activeId2];
      if (activeId2 && this.creatureBodies[activeId2] && c) {
        const MatterBody = (Phaser.Physics.Matter as any).Matter.Body;
        const body = this.creatureBodies[activeId2];
        MatterBody.setPosition(body, { x: c.x, y: c.y });
        // Use scaled estimated server velocity on manual resync
        const prev = this.lastServerPos[activeId2];
        const prevT = this.lastServerTime[activeId2] ?? 0;
        const nowT = Date.now();
        const dt = (nowT - prevT) / 1000;
        if (prev && dt > 0.0001) {
          const srvVx = (c.x - prev.x) / dt;
          const srvVy = (c.y - prev.y) / dt;
          MatterBody.setVelocity(body, { x: srvVx * this.velocityScale, y: srvVy * this.velocityScale });
        }
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyZoomOut)) {
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom * 0.9, 0.5, 2));
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyZoomIn)) {
      this.cameras.main.setZoom(Phaser.Math.Clamp(this.cameras.main.zoom / 0.9, 0.5, 2));
    }
    if (this.followEnabled && activeId) {
      if (this.lastFollowId !== activeId) {
        const target = this.creatureGraphics[activeId];
        if (target) {
          this.cameras.main.startFollow(target, false, 0.2, 0.2);
          this.lastFollowId = activeId;
        }
      }
    }
  }

  private getWeaponForMe(): string | undefined {
    const stateAny: any = this.room?.state as any;
    const map: any = stateAny?.weaponsByPlayer || {};
    const sid = this.room?.sessionId || '';
    if (!sid) return undefined;
    const get = typeof map.get === 'function' ? map.get.bind(map) : (k: string) => map[k];
    return get(sid);
  }

  private maybeExplodeGrenade() {
    if (!this.grenade) return;
    if (Date.now() < this.grenade.explodeAt) return;
    const gBody = this.grenade.body;
    const gx = gBody?.position?.x ?? this.grenade.gfx?.x ?? 0;
    const gy = gBody?.position?.y ?? this.grenade.gfx?.y ?? 0;
    const MatterBody = (Phaser.Physics.Matter as any).Matter.Body;
    const hits: { id: string; dmg: number }[] = [];
    for (const [cid, b] of Object.entries(this.creatureBodies)) {
      const dx = (b as any).position.x - gx;
      const dy = (b as any).position.y - gy;
      const d = Math.hypot(dx, dy);
      if (d <= this.explosionRadius) {
        const nx = dx / (d || 1);
        const ny = dy / (d || 1);
        const falloff = Math.max(0, 1 - d / this.explosionRadius);
        const force = this.explosionForce * falloff;
        MatterBody.applyForce(b, (b as any).position, { x: nx * force, y: ny * force - 0.002 });
        const dmg = Math.round(100 * falloff);
        hits.push({ id: cid, dmg });
      }
    }
    if (hits.length > 0) this.room?.send('applyDamage', { hits });
    // Cleanup grenade visual/body
    try { if (gBody) this.matter.world.remove(gBody); } catch {}
    if (this.grenade.gfx) this.grenade.gfx.destroy();
    this.grenade = null;
  }

  private drawTerrain() {
    const stateAny = this.room.state as any;
    let pts: number[] = [];
    const tp2 = (stateAny as any).terrainPoints;
    if (tp2 && typeof tp2.length === 'number' && tp2.length >= 4) {
      for (let i = 0; i < tp2.length; i++) pts.push(tp2[i]);
      this.terrainSource = 'server';
    }
    if (pts.length < 4) {
      // fallback: build locally so terrain is always visible
      pts = this.generateIslandPoints();
      this.terrainSource = 'client';
    }
    this.waterline = stateAny.waterline ?? this.waterline;
    // destroy previous terrain if re-drawing
    this.terrainGraphics?.destroy();
    this.waterRect?.destroy();
    // remove previous physics terrain
    if (this.terrainBodies.length) {
      for (const b of this.terrainBodies) {
        try { this.matter.world.remove(b); } catch {}
      }
      this.terrainBodies = [];
    }
    // water
    // Huge water rectangle from waterline downwards (static, world-aligned)
    this.waterRect = this.add
      .rectangle(-100000, this.waterline, 200000, 100000, 0x223344)
      .setOrigin(0, 0)
      .setDepth(2);
    if (pts.length >= 4) {
      const g = this.add.graphics();
      g.fillStyle(0x2b3b2b, 1);
      g.lineStyle(2, 0x132313, 1);
      g.beginPath();
      g.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      // Close polygon to bottom using min/max X from points
      let minX = pts[0];
      let maxX = pts[0];
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      g.lineTo(maxX, this.height);
      g.lineTo(minX, this.height);
      g.closePath();
      g.fillPath();
      g.strokePath();
      g.setDepth(1);
      this.terrainGraphics = g;

      // Build collision segments for terrain (client-side Matter physics)
      const parts: any[] = [];
      const thickness = 20;
      for (let i = 2; i < pts.length; i += 2) {
        const ax = pts[i - 2];
        const ay = pts[i - 1];
        const bx = pts[i];
        const by = pts[i + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const angle = Math.atan2(dy, dx);
        let nx = -dy / len;
        let ny = dx / len;
        if (ny < 0) { nx = -nx; ny = -ny; }
        const offX = nx * (thickness / 2);
        const offY = ny * (thickness / 2);
        const cx = (ax + bx) / 2 + offX;
        const cy = (ay + by) / 2 + offY;
        const seg = this.matter.add.rectangle(cx, cy, len, thickness, { isStatic: true, angle, friction: 0.9, restitution: 0.1 });
        parts.push(seg);
      }
      this.terrainBodies = parts;
    }
  }

  private offerTakeoverIfAvailable() {
    if (!this.room) return;
    const stateAny = this.room.state as any;
    const names: any = stateAny.playerNames || {};
    const dmap: any = stateAny.disconnectedUntil || {};
    // Extract disconnected ids still within grace
    const now = Date.now();
    const entries: Array<{ id: string; name: string; until: number }> = [];
    const add = (id: string, until: number) => {
      if (typeof until === 'number' && until > now) {
        const nm = names?.get?.(id) ?? names?.[id] ?? id;
        entries.push({ id, name: nm, until });
      }
    };
    if (typeof dmap.forEach === 'function') {
      dmap.forEach((until: number, id: string) => add(id, until));
    } else {
      Object.keys(dmap || {}).forEach((id) => add(id, (dmap as any)[id]));
    }
    if (entries.length === 0) return;
    const list = entries.map((e, i) => `${i+1}. ${e.name}`).join('\n');
    const resp = window.prompt(`Take over a disconnected player?\n${list}\nEnter number or leave blank to skip:`);
    if (!resp) return;
    const idx = parseInt(resp, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= entries.length) {
      const choice = entries[idx - 1];
      this.room.send('takeover', { targetSessionId: choice.id });
    }
  }

  private generateIslandPoints(): number[] {
    const base = 400;
    const amp = 120;
    const segments = 40;
    const pts: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = t * this.width;
      const n = Math.sin(t * Math.PI * 2) * 0.3 + Math.sin(t * Math.PI * 6 + 1.3) * 0.2 + Math.sin(t * Math.PI * 10 + 2.7) * 0.15;
      const y = base - (Math.cos(Math.PI * (t - 0.5)) * 0.5 + 0.5) * 60 - n * amp;
      pts.push(x, y);
    }
    return pts;
  }

  private updateBackdrop() {
    const cam = this.cameras.main;
    const zoom = cam.zoom || 1;
    const worldW = cam.displayWidth / zoom;
    const worldH = cam.displayHeight / zoom;
    const centerX = cam.worldView.centerX;
    const centerY = cam.worldView.centerY;

    // Sky fills entire view
    if (this.skyRect) {
      this.skyRect.width = worldW + 2; // small padding
      this.skyRect.height = worldH + 2;
      this.skyRect.x = centerX;
      this.skyRect.y = centerY;
    }

    // Water fills from waterline to bottom of view, and a generous width around center (infinite feel)
    if (this.waterRect) {
      const top = this.waterline;
      const bottom = cam.worldView.bottom;
      const height = Math.max(bottom - top, 0);
      const width = worldW * 2; // wider than view to avoid edges
      this.waterRect.width = width;
      this.waterRect.height = height + 2;
      this.waterRect.x = centerX;
      this.waterRect.y = top + (height / 2);
    }
  }

  // (no per-creature ensure method; active client manages bodies for all creatures)
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: "#1f2630",
  parent: undefined,
  pixelArt: true,
  physics: {
    default: 'matter',
    matter: {
      gravity: { y: 1 },
    }
  },
  // client simulates locally for responsiveness; server remains authoritative
  scene: [GameScene],
};

new Phaser.Game(config);
