# Encore 🎵

A music player for the web, styled like a streaming app. It runs entirely on **GitHub Pages**: no server, no accounts, no API keys.

## Features
- **Search any song**
  - **Full tracks**: full-length, free, legal streams from independent artists on [Audius](https://audius.co)
  - **Previews**: 30-second official previews of almost any mainstream song, from the iTunes catalog
  - **My Files**: upload songs you own (MP3, M4A, FLAC, WAV, OGG) for full playback, stored privately in your browser
- **Playlists**: create, rename, delete, add and remove songs
- **Liked Songs**
- **Monthly Stats**: minutes listened, plays, top songs, top artists, top genres, minutes per day, peak hour, and a month picker. You can also turn a month's top songs into a playlist.
- Shuffle, repeat (all/one), keyboard shortcuts (Space, Shift+←/→), and lock-screen controls
- Export and import a backup of your playlists and stats (Library → Backup)
- Works on mobile

## Deploy on GitHub Pages
1. Create a new repository on GitHub, for example `encore`.
2. Click **Add file → Upload files** and drag in `index.html`, `style.css`, `app.js` and `README.md`. Commit.
3. Go to **Settings → Pages**. Under *Source*, choose **Deploy from a branch**, select `main` and `/ (root)`, then click **Save**.
4. About a minute later, your app is live at `https://<your-username>.github.io/encore/`.

## Notes
- Your data (playlists, likes, history, uploaded files) is saved in **your browser** on each device. Use Export and Import to move it between devices.
- A song counts toward your stats after 15 seconds of listening.
