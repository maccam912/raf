import Phaser from "phaser";
import { Client, Room } from "colyseus.js";

type Creature = { id: string; ownerSessionId: string; x: number; y: number; radius: number; color: string };
type RoomState = {
  creatures: Map<string, Creature> | Record<string, Creature>;
  activePlayerSessionId: string;
  activeCreatureId: string;
  turnRemainingMs: number;
};

class GameScene extends Phaser.Scene {
  private client!: Client;
  private room!: Room<RoomState>;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { up: Phaser.Input.Keyboard.Key; down: Phaser.Input.Keyboard.Key; left: Phaser.Input.Keyboard.Key; right: Phaser.Input.Keyboard.Key };
  private space!: Phaser.Input.Keyboard.Key;

  private creatureGraphics: Record<string, Phaser.GameObjects.Arc> = {};
  private creatureBodies: Record<string, any> = {};
  private terrainBodies: any[] = [];
  private lastServerPos: Record<string, { x: number; y: number }> = {};
  private lastServerTime: Record<string, number> = {};
  private lastAutoResyncAt: Record<string, number> = {};
  private localActiveId: string | null = null;
  private lastSent = 0;
  private lastStateSent = 0;

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

    (document.getElementById("status")!).textContent = "Connecting to server...";
    this.client = new Client("ws://localhost:2567");
    this.room = await this.client.joinOrCreate<RoomState>("rebate_attack_force");
    (document.getElementById("status")!).textContent = `Connected. Your session: ${this.room.sessionId}`;

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
        // Active client simulates whole world; others smooth to server
        const isMyTurnNow = this.room.sessionId === (stateAny).activePlayerSessionId;
        if (isMyTurnNow) {
          let body = this.creatureBodies[id];
          if (!body) {
            body = this.matter.add.circle(c.x, c.y, c.radius, {
              restitution: 0.9, // bouncy collisions between creatures
              friction: 0.05,
              frictionStatic: 0.05,
              frictionAir: 0.005,
              // density: 0.001, // default is fine; equal sizes -> fair energy exchange
            });
            this.creatureBodies[id] = body;
          }
          gfx.x = body.position.x;
          gfx.y = body.position.y;
        } else {
          if (this.creatureBodies[id]) {
            try { this.matter.world.remove(this.creatureBodies[id]); } catch {}
            delete this.creatureBodies[id];
          }
          const baseAlpha = 1 - Math.exp(-delta / this.posSmoothingTau);
          const dx = c.x - gfx.x;
          const dy = c.y - gfx.y;
          const fastYAlpha = 1 - Math.exp(-delta / 50);
          const alphaY = dy > 0 ? Math.max(baseAlpha, fastYAlpha) : baseAlpha;
          gfx.x += dx * baseAlpha;
          gfx.y += dy * alphaY;
        }

        // Track server patches only for non-active clients (bookkeeping)
        if (!(this.room.sessionId === (stateAny).activePlayerSessionId)) {
          const prev = this.lastServerPos[id];
          const nowT = Date.now();
          const changed = !prev || prev.x !== c.x || prev.y !== c.y;
          if (changed) {
            this.lastServerPos[id] = { x: c.x, y: c.y };
            this.lastServerTime[id] = nowT;
          }
        }
      });
    }

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

    // Control only on our active creature
    const isMyTurn = this.room.sessionId === (stateAny).activePlayerSessionId;
    const activeId = (stateAny).activeCreatureId as string;
    // When not my turn, ensure no leftover physics bodies remain
    if (!isMyTurn) {
      for (const id of Object.keys(this.creatureBodies)) {
        try { this.matter.world.remove(this.creatureBodies[id]); } catch {}
        delete this.creatureBodies[id];
      }
    }
    if (isMyTurn && activeId) {
      const left = this.cursors.left.isDown || this.wasd.left.isDown;
      const right = this.cursors.right.isDown || this.wasd.right.isDown;
      if (Phaser.Input.Keyboard.JustDown(this.space)) {
        this.room.send("endTurn");
      }
      if (Phaser.Input.Keyboard.JustDown(this.cursors.up) || Phaser.Input.Keyboard.JustDown(this.wasd.up)) {
        // Immediate local jump only (no server message)
        const body = this.creatureBodies[activeId];
        if (body) {
          const MatterBody = (Phaser.Physics.Matter as any).Matter.Body;
          MatterBody.applyForce(body, body.position, { x: 0, y: -0.03 });
        }
      }
      // Apply held forces locally for responsiveness
      const body = this.creatureBodies[activeId];
      if (body) {
        const MatterBody = (Phaser.Physics.Matter as any).Matter.Body;
        const forceX = (left ? -0.0015 : 0) + (right ? 0.0015 : 0);
        if (forceX !== 0) {
          MatterBody.applyForce(body, body.position, { x: forceX, y: 0 });
        }
        // Sending world state happens just after force application (outside this block)
      }
      // Send authoritative world state to server at ~20Hz (all creatures)
      if (time - this.lastStateSent > 50) {
        const updates: { id: string; x: number; y: number }[] = [];
        for (const [cid, b] of Object.entries(this.creatureBodies)) {
          updates.push({ id: cid, x: (b as any).position.x, y: (b as any).position.y });
        }
        if (updates.length > 0) this.room.send("worldState", { updates });
        this.lastStateSent = time;
      }
    }

    // Highlight active creature
    Object.entries(this.creatureGraphics).forEach(([id, gfx]) => {
      const isActive = id === activeId;
      gfx.setStrokeStyle(isActive ? 4 : 1, isActive ? 0xffff00 : 0x111111);
    });

    // Backdrop is static (no per-frame resizing for performance)

    // UI updates
    (document.getElementById("turn")!).textContent = isMyTurn ? "Your turn" : "Waiting for others";
    const secs = Math.ceil((((stateAny).turnRemainingMs || 0) as number) / 1000);
    (document.getElementById("timer")!).textContent = `Turn ends in: ${secs}s`;

    // Debug overlay
    const tpObj = (stateAny as any).terrainPoints;
    const tpLen = tpObj && typeof tpObj.length === 'number' ? tpObj.length : 0;
    const debug = document.getElementById('debug');
    if (debug) {
      debug.textContent = `terrainPoints=${tpLen} source=${this.terrainSource} drawn=${this.terrainDrawn} creatures=${seen.size} follow=${this.followEnabled} zoom=${this.cameras.main.zoom.toFixed(2)} active=${activeId ?? ''}`;
    }

    // Camera follow / zoom
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
