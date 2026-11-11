# ChessNeurons Puzzle PGN Decryptor — Manual

## What it does

This Tampermonkey userscript runs on `chessneurons.com` and decrypts the PGN
data for the site's puzzles so you can read them as plain chess notation instead 
of the obfuscated base64/XOR string the site sends.

It works entirely **passively**: it watches the page's own network traffic.
When chessneurons.com calls its API to load the daily batch (`fetchpuzzles`) 
or open a specific past puzzle (`/puzzle`), the script quietly reads that 
request/response. It never makes any network requests of its own — no API calls 
are fired that the page didn't already make itself.

Once it has the raw data, it decrypts each puzzle's PGN locally in your
browser (XOR with a key derived from the puzzle ID + active date) and
displays everything in an on-page panel.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension if you don't have it.
2. Open Tampermonkey → **Create a new script**.
3. Delete the placeholder content and paste in the full contents of
   `chessneurons-pgn-decryptor.user.js`.
4. Save (Ctrl/Cmd+S).
5. If you're on a newer Chrome/Edge version, Tampermonkey's extension page
   may show an **"Allow User Scripts"** toggle — make sure it's turned on,
   otherwise Tampermonkey can't inject any userscript at all.

## How to use it

1. Visit any puzzle page on `chessneurons.com`.
2. A button appears in the top-right corner:
   - While the page hasn't made its own puzzle request yet, it shows
     **"Waiting for puzzles…"** and is greyed out/disabled.
   - As soon as the site's own puzzle data call completes (usually
     within a second or two of page load, or when you click to open a 
     past puzzle), the button switches to **"Show Decrypted PGNs"** and 
     becomes clickable.
3. Click it to open a panel showing all decrypted puzzles. The panel 
   groups them into **EASY**, **HARD**, and **OPENED / HISTORY** sections.

## Options / controls

- **Copy button (per section)** — each section has its own **Copy** button 
  that copies just that section's puzzles to your clipboard as valid PGN text. 
  Disabled until that section has been captured.
- **Download button (per section)** — same as Copy, but downloads a
  `.pgn` file instead.
- **Valid PGN output** — the copied/downloaded text is standard PGN. Each
  puzzle's original tags are kept, with these overridden/added so the file
  works well when imported straight into a **Lichess study**:
  - `[ChapterName "YYYY-MM-DD #N"]` — the puzzle's active date and number,
    so Lichess shows a scrollable, readable chapter name instead of a bare
    "Chapter N".
  - `[Event "Easy - theme1, theme2"]` / `[Event "Hard - theme1, theme2"]` —
    difficulty tier plus the puzzle's theme tags (if any).
  - `[WhiteElo "1300"]` / `[BlackElo "1300"]` — the puzzle's difficulty
    rating, shown by Lichess as a rating badge.
  No extra prose or separator lines are included, so the file can be
  imported directly as a Lichess study (or opened in any other
  PGN-compatible chess viewer/database).
- **Close button** — closes the panel. The toggle button reappears so you
  can reopen it later (it stays enabled once puzzles have been captured).
- **Drag to move** — click and drag the panel's header bar to reposition it
  anywhere on screen.
- **Select/copy text** — the PGN text is also plain selectable text directly
  in the panel.

## What you don't have to do

- You don't need to open dev tools or manually copy network requests —
  the script does that for you.
- You don't need to log in or provide any credentials.
- You don't need to click anything to trigger the data fetch — it happens
  automatically as a side effect of you browsing the site normally.

## Notes / limitations

- The script only recognizes requests to `fetchpuzzles` or `/puzzle`, so
  it's specific to this API and won't affect other site traffic.
- Because capture is purely passive, if the page never calls the puzzle API
  during your visit, the button stays disabled — load a puzzle to trigger it.
- If chessneurons.com changes its encryption scheme or API response shape,
  the decryption or capture logic will need to be updated to match.
