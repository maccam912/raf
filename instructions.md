Multiplayer Phaser + Colyseus Tutorial
This guide will walk you through building a multiplayer experience using the Colyseus Multiplayer Framework and Phaser.

Table of Contents
Basic Player Movement

Linear Interpolation

Client Predicted Input

Fixed Tickrate

References & Materials

1. Basic Player Movement
Goal:

Set up a Colyseus server & Phaser client.

Connect multiple players into a room.

Use arrow keys to move players across the network.

Prerequisites
Basic knowledge of Phaser 3, JavaScript/TypeScript, Node.js.

Server Setup
bash
npm init colyseus-app ./server
cd server
npm start
Your server should start at ws://localhost:2567

Client Setup
bash
mkdir client
cd client
npm init -y
npm install --save-dev parcel typescript
npm install --save phaser colyseus.js
npx tsc --init
Set "strict": false in tsconfig.json

Write a minimal index.html:

xml
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Colyseus + Phaser Example</title>
  </head>
  <body>
    <script src="index.ts" type="module"></script>
  </body>
</html>
Basic Phaser entrypoint (index.ts):

typescript
import Phaser from "phaser";
export class GameScene extends Phaser.Scene {
  preload() {}
  create() {}
  update(time: number, delta: number) {}
}
const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#b6d53c',
  parent: 'phaser-example',
  physics: { default: "arcade" },
  pixelArt: true,
  scene: [ GameScene ],
};
const game = new Phaser.Game(config);
Serve client:

bash
npx parcel serve index.html
Colyseus Client Connection in Phaser
typescript
import { Client, Room } from "colyseus.js";
export class GameScene extends Phaser.Scene {
  client = new Client("ws://localhost:2567");
  room: Room;
  async create() {
    this.room = await this.client.joinOrCreate("my_room");
  }
}
Room State & Schema (Server)
typescript
import { MapSchema, Schema, type } from "@colyseus/schema";
export class Player extends Schema {
  @type("number") x: number;
  @type("number") y: number;
}
export class MyRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
Player Lifecycle
Adding: Add new player to state on join.

Removing: Remove player from state on leave.

Client Event Handling Example
typescript
// Listen for new players
$(this.room.state).players.onAdd((player, sessionId) => {
  // Create a sprite or GameObject for the player, etc.
});
2. Linear Interpolation
Goal: Smooth movement using linear interpolation between server state updates.

Why Smoothing?
Colyseus sends state updates at 20fps, browsers render at 60fps. So, interpolate positions!

Implementation
On state change: Cache the target position instead of setting it immediately.

typescript
$(player).onChange(() => {
  entity.setData('serverX', player.x);
  entity.setData('serverY', player.y);
});
On update: Interpolate toward the cached server positions.

typescript
for (let sessionId in this.playerEntities) {
  const entity = this.playerEntities[sessionId];
  const { serverX, serverY } = entity.data.values;
  entity.x = Phaser.Math.Linear(entity.x, serverX, 0.2);
  entity.y = Phaser.Math.Linear(entity.y, serverY, 0.2);
}
3. Client Predicted Input
Goal: Immediate local feedback for the player’s own movement (client-side prediction), smoothing only for remote players.

Steps
Detect current player using the session id.

Update local player visually immediately upon input.

Still interpolate remote players as before.

typescript
if (sessionId === this.room.sessionId) {
  // This is the local player, handle differently!
}
typescript
// On input
if (input.left) { currentPlayer.x -= velocity; } // etc
// Also send to server.
this.room.send(0, input);
Interpolate only remote players:

typescript
if (sessionId !== this.room.sessionId) {
  // interpolate...
}
4. Fixed Tickrate
Goal: Deterministic simulation—process input and physics steps at a fixed tickrate on both server and client for reliable sync.

Server
Queue player inputs, consume them at each fixed tick.

typescript
this.setSimulationInterval((deltaTime) => {
  // dequeue and process all inputs
});
Client & Server: Fixed Tick
typescript
elapsedTime += delta;
while (elapsedTime >= fixedTimeStep) {
  elapsedTime -= fixedTimeStep;
  fixedTick(fixedTimeStep);
}
Use same tick/logic on the client for smoothness regardless of framerate.
