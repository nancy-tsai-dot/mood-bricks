# 🧱 Mood Bricks

An anonymous, playful emoji check-in for a team, made at the LEGO Imaginarium workshop on Creative Dividends.

**Try it:** https://nancy-tsai-dot.github.io/mood-bricks/

- Once a day, at a random time between 9:00 and 17:00, a check-in pops up: *How do you feel about your work right now?* Answer with one of five emoji (🫠 😕 🙂 😊 🔥).
- Answering unwraps a surprise: a meme, animal or GIF that a teammate added.
- Your streak is saved only in your own browser.
- The **Team wall** shows one brick per workday, coloured by the team's average. Days with fewer than 3 answers stay grey, so nobody can be singled out. Work events (releases, sprint starts) appear on the wall, and the app points out patterns.
- The team goal: reach 80% of possible check-ins in a month to unlock a minifig badge.

## How it works

A plain static website (`index.html`, `style.css`, `app.js`) hosted on GitHub Pages. Shared answers are stored in a Firebase Firestore database.

- No names or logins. Answers (date, hour, score) are stored apart from check-ins (a random browser id and date), which are used only to count the team goal.
- The Firebase key in `app.js` is meant to be public. `firestore.rules` limits what anyone can write: valid answers only, no edits, no deletes.
- Anyone with the link can add answers, so this suits a workshop or test, not sensitive use.

## Reset the data

In the [Firebase console](https://console.firebase.google.com/project/mood-bricks/firestore), open **Firestore → Data**. For each collection, click the ⋮ menu and choose **Delete collection**.

## Run it locally

Open the folder with any static web server, e.g. `python3 -m http.server 8000`, then go to http://localhost:8000.
