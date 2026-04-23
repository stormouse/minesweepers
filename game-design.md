# Minesweepers Game Design

"Minesweepers" is an online multiplayer co-op & competitive game. The core operations are borrowed from the original Minesweeper game.

## The Original Minesweeper Gameplay

Minesweeper is a game where mines are hidden in a grid of squares. Safe squares have numbers telling you how many mines touch the square. You can use the number clues to solve the game by opening all of the safe squares. If you click on a mine you lose the game!

You open squares with the left mouse button and put flags on mines with the right mouse button. Pressing the right mouse button again changes your flag into a questionmark. When you open a square that does not touch any mines, it will be empty and the adjacent squares will automatically open in all directions until reaching squares that contain numbers.

If you flag all of the mines touching a number, chording on the number opens the remaining squares. Chording is when you press both mouse buttons at the same time. This can save you a lot of work! However, if you place the correct number of flags on the wrong squares, chording will explode the mines.

The game ends when all safe squares have been opened. A counter shows the number of mines without flags, and a clock shows your time in seconds. Minesweeper saves your best time for each difficulty level.

You also can play Custom games up to 30x24 with a minimum of 10 mines and maximum of (x-1)(y-1) mines.

## The "Minesweepers" Gameplay

All players first join a lobby and start the game. Players in a lobby share the same "mine field" (the grid of squares). Each player has a player color. The game starts with the system automatically opening a safe square for each player. The server ensures starting squares are placed far enough apart that no two players' initial territories overlap.

There is a concept of "territory" — territory of each player is marked with a player-specific colored stroke around the contour of their squares. A player can only click and flag squares inside their own territory.

A player's territory is defined as the bounding box of all their opened squares, extended 2 blocks in each direction. A player who has opened only square (x, y) controls the 5×5 area (x-2, y-2) to (x+2, y+2). Because territory expands incrementally with each adjacent opening, a player's opened squares always form a contiguous region — so the bounding box stays compact.

Territory expands whenever a player opens a new square (including via chording). If the expanded bounding box would overlap another player's territory, the overlapping cells belong to whichever player opened them first; the server is authoritative on ordering.

Players that explode lose all of their territory immediately and are considered eliminated. Their territory becomes neutral and any player can expand into it.

The game finishes when all mines are flagged (by any players combined), or all players are eliminated. Incorrectly placed flags block this condition — the game does not end until the flagged mine count equals the total mine count and all flags are correct.

The final score of a player is the number of squares in their territory × 1, plus mines correctly flagged × 2.

## Game Implementation

The game should be playable on web and features a modern, minimalist style. Consider WebSocket for real-time multiplayer. Disconnected users are considered eliminated and their territory immediately becomes neutral.

## Bugs

- Game should end when all SURVIVORS' flags are correct. (Dead player's wrong flags shouldn't block the game)
- Territories can eat other territories.
