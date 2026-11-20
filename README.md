# Vision

A cel-shaded 4v4 samurai clan battle that runs in the browser.

- **Lobby** with your equipped warrior, collection screens and a Play button
- **Gacha** for 10 warriors and 10 swords across Common, Rare, Epic and Legendary
- **Town map**: a walled Japanese town with houses you can walk into, a shrine, pagoda, market and zen garden; clans start at opposite gates and fight through the streets
- **Rooftops**: climb ladders onto the roofs, fire a rope to the next house, balance across it and take it back
- **Villagers**: six different townsfolk (farmer, monk, fisher, elder, brewer, naginata fighter) who attack both clans
- **Combat**: 3-hit slash combo, guard-breaking heavy, block and parry, dash
- **Settings**: 30/60/120 fps, low/medium/high quality, and three control modes — keyboard & mouse, touch with a movable button layout, and controller (auto-detects Xbox or PlayStation, with rebindable buttons for each)

## Online multiplayer

`server.js` serves the game, matches players together and referees each match. It has no dependencies.

- Press **Online → Find match**. Once two players are searching, a 10-second countdown starts and everyone searching (up to 8) is put in one match, split across the two clans. Empty spots are computer fighters.
- The match runs on the server, which loads the game's own script from `index.html` without a screen, so the rules can never drift apart. Every player sends inputs and receives the same state 20 times a second.
- Your own movement, slashes and dashes are shown at once on your screen and then corrected against the server.

### Deploy on Render

1. On render.com choose **New → Blueprint** and connect this repository. `render.yaml` sets everything up.
   (Or **New → Web Service**: runtime Node, build command empty, start command `node server.js`.)
2. Open the `…onrender.com` address Render gives you. That page is the game; press **Online** in the lobby.

On the free plan the server sleeps when idle, so the first visit can take about a minute to wake it.

Run it locally with `node server.js` and open http://localhost:3000.

## Run it

Single-player needs only `index.html`: open it in a browser, or serve the folder with any static host.
It loads three.js r128 and a font from public CDNs, so it needs an internet connection.

Progress (orbs and collection) is saved in the browser's local storage.
