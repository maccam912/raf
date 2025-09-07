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
  private lastSent = 0;

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
        // Authoritative position from server with delta-based smoothing
        const baseAlpha = 1 - Math.exp(-delta / this.posSmoothingTau);
        const dx = c.x - gfx.x;
        const dy = c.y - gfx.y;
        // Speed up catch-up when landing (server Y below current)
        const fastYAlpha = 1 - Math.exp(-delta / 50);
        const alphaY = dy > 0 ? Math.max(baseAlpha, fastYAlpha) : baseAlpha;
        gfx.x += dx * baseAlpha;
        gfx.y += dy * alphaY;
      });
    }

    // Remove entities that no longer exist on server
    Object.keys(this.creatureGraphics).forEach((id) => {
      if (!seen.has(id)) {
        this.creatureGraphics[id]?.destroy();
        delete this.creatureGraphics[id];
      }
    });

    // Control only on our active creature
    const isMyTurn = this.room.sessionId === (stateAny).activePlayerSessionId;
    const activeId = (stateAny).activeCreatureId as string;
    if (isMyTurn && activeId) {
      const left = this.cursors.left.isDown || this.wasd.left.isDown;
      const right = this.cursors.right.isDown || this.wasd.right.isDown;
      if (time - this.lastSent > 50) {
        this.room.send("input", { left, right });
        this.lastSent = time;
      }
      if (Phaser.Input.Keyboard.JustDown(this.space)) {
        this.room.send("endTurn");
      }
      if (Phaser.Input.Keyboard.JustDown(this.cursors.up) || Phaser.Input.Keyboard.JustDown(this.wasd.up)) {
        this.room.send("jump");
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
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: "#1f2630",
  parent: undefined,
  pixelArt: true,
  // client is render-only; physics runs on server
  scene: [GameScene],
};

new Phaser.Game(config);
