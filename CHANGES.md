# Changes

## 1.2.0

- **Air grab: move files with your hand.** Turn it on in the phone's Settings (Android asks for the camera once). Hold
  your open hand over Flick and the file under it lights up; pinch to select it, and keep pinching across more files;
  make a fist to grab the file open full screen, the selection or the lit-up file, then open your hand in front of the
  PC: the file lands where your hand is, or comes in from the edge on a PC without a camera. Open your hand over the
  phone again to put it back. A video that was playing carries on on the PC from the same second. The other way: with
  Flick open on the phone, select files on the PC, close your open hand into a fist in front of the screen, then open it
  over the phone (on Linux, copy the files instead of selecting them). Works on Windows, Mac and Linux, with or without a
  webcam. The phone's camera runs only while Flick is open and connected with Air grab on; the PC's only for a few
  seconds, after a grab or after you select files (Files > Air grab in Flick's window). Hand tracking runs on the
  device: no picture leaves it.

## 1.1.0

- Fixed: on Android 17 (Galaxy Z Fold 8 and other phones with One UI 9), Flick closed as soon as it was opened.
- **Large files are checked end to end.** A large file travels in several parts at once; the phone now also sends
  the whole file's checksum, and the PC confirms the file it put together matches before it counts as received. A
  file that arrived damaged is sent again instead of being saved. (Works once both the phone and the PC have the new
  version.)
- Fixed: when the phone retried a transfer, the attempt it replaced could be left waiting for an answer that never
  came.
- Flick on the PC closes connections that take longer than 20 seconds to send a request, and closes WebSocket
  connections that break the protocol.
- Leftover temporary files from transfers that never finished are also cleaned up while Flick runs, not only when it
  starts.
- If Flick on the phone closes unexpectedly, the next time it opens it shows what went wrong, with a Copy button to
  pass it on.
- **Flick for Mac and Linux.** The PC app now runs on macOS 13 or newer (`Flick-mac-arm64.dmg` for Apple silicon,
  `Flick-mac-x64.dmg` for Intel Macs) and on 64-bit Linux (`Flick-linux-x86_64.AppImage`, or `Flick-linux-x64.tar.gz`),
  and updates itself there too. On a Mac, Flick lives in the menu bar: drop files on it or on its Dock icon, or choose
  Open With > Flick in Finder, to send them to the phone. On Linux, Flick is in the applications menu and in your file
  manager's Open With. Bluetooth stays Windows only; the phone's media remote needs Accessibility permission on a Mac
  and playerctl on Linux.
- Windows: right-click files or a folder in File Explorer and choose **Send with Flick** (on Windows 11 under Show
  more options). Installing this version adds it.
- **Sends keep going when you close Flick.** Close the app or swipe it away while files are going to the PC and they
  keep going in the background, with their progress in the notification. If the Wi-Fi drops, the PC goes to sleep or
  Android stops the app anyway, the send waits and carries on from where it stopped (not from the start) as soon as
  the PC can be reached again, for up to 6 hours. The PC shows "Paused, waiting for the phone" meanwhile.
- **Transfers page** on the phone (tap "Sending…" in the toolbar, or ••• > Transfers): every send with its progress,
  speed and time left, and Pause, Resume, Cancel and Try again.
- **Faster.** The phone sends straight to the PC over the encrypted link (no detour through the app's local proxy), in
  up to 6 parts at once for large files, and the PC checks each part as it arrives instead of reading the whole file
  back at the end. Large files from the PC come straight too. Settings > Speed test shows how fast your connection
  is right now, and what your Wi-Fi is doing.
- **Skip files already on the PC** (Settings, on by default): a photo or video the PC already has isn't sent again;
  the PC says "Already on this PC".
- **Every PC is remembered, with every address it has.** The phone finds a PC it paired with again by itself, at home
  or at work, even on networks where it was found by typing its address; when the PC used last isn't around but
  another paired one is, it switches to that one. PCs are also found over mDNS. Paired PCs connect when Flick opens,
  without holding Connect (Settings > Connect automatically).
- **Share with a browser, from another Wi-Fi.** "On another Wi-Fi?" in the share view makes a Wi-Fi network on the PC
  (Windows Mobile hotspot, or a Wi-Fi Direct network; on Linux, NetworkManager's hotspot): scan the first code to join
  it, then the second to open the page.
- **Browse your phone from the PC.** Browse your phone in the Flick window shows the phone's photos, videos,
  downloads, documents and folders; pick files and click Copy to PC. Works while Flick is open on the phone, or closed
  with "Stay connected in the background". Off until you turn on "Let your PC browse this phone" in the phone's
  Settings; the PC can only look and copy.
- **Clipboard history.** The last 20 texts, links and pictures copied between phone and PC, on each side: in the Flick
  window (Copy, Send to phone) and on the phone (••• > Clipboard history: tap to copy, Send to PC). Kept only on that
  device, never anything marked as private. Clear it, or turn it off in Settings.
- **Ask before saving.** For each phone, the PC can Always accept (as before) or Ask each time: files from that phone
  then wait for Accept or Decline, with their name, count and size. Declined, or not accepted within a minute, the
  phone says so.
- **Send feedback** from the phone (Settings > Send feedback) or the PC (at the bottom of the Flick window): a bug or
  an idea, an optional email address and, if you leave it ticked, the device info shown under it. Without a
  connection it is sent later.
- **List view.** The switch next to search shows files as rows with a small picture, name, size, date and type, and
  Flick remembers it. Rows work like the grid: tap, press and hold to select, or drag one off the edge to send it.
- **Sort and search.** Sort any tab by name, date, size or type, either way round; each tab keeps its own order.
  Search finds files in the folder or category you're in as you type.
- **Preview.** Tap Preview in a file's menu, or spread two fingers on it, to see it full screen: zoom into photos,
  play videos, swipe to the next one, and tap Send or flick the file up to send it to your PC.
- **Pinned folders.** Pin a folder from its menu and it gets its own tab after Documents. Press and hold the tab to
  move or unpin it.
- **Tips.** After you pair, four short tips show how to flick files, send several at once, send from the PC and find
  Settings. Show tips again in Settings brings them back.
- **Lock Flick.** In Settings, Flick can ask for your fingerprint, face or PIN when it opens and when you come back
  after more than 30 seconds. Transfers keep running while it's locked, and the tiles and the widget keep working.
- Fixed: a file sent from the PC never arrived if the phone was scrolled far down a long list when it was sent.

## 1.0.0

The first release.

- **Flick files across.** Drag a file off the edge of your phone toward the PC and it lands there, with one of four
  animations (Roadster, Liquid, Teleport, Halo). Several files and whole folders work too. Send PC files to the phone
  with a button, by dropping them on the Flick window, or from File Explorer: right-click > Send to > Flick (phone).
- **Any way you connect.** Wi-Fi, a USB cable, the phone's hotspot or Bluetooth. Flick uses the fastest and moves over
  when a faster one appears; large files and batches travel over several connections at once.
- **Share with a browser.** iPhones, iPads, Macs or any computer can send files to your PC and download files you
  share, from a web browser with no app: click Share with a browser in Flick on the PC and scan the QR code. Both
  screens show a 4-digit code; click Allow only if they match. Sharing stops by itself after 30 minutes unused.
- **Shared clipboard.** Copy on one device, paste on the other: text, links and pictures. What you copy on the PC
  reaches the phone by itself; on the phone, Flick sends its clipboard when you open it (turn on Clipboard sync in
  Settings) or when you choose Send clipboard. Passwords copied from a password manager are never sent.
- **Auto-send new screenshots or photos** (off until you turn it on): take a screenshot and it appears on the PC.
- **History** on both the phone and the PC, with Open, Show in folder and Send again.
- **Send a link** to the other device and it opens there. On the PC: the field under Phones, or the tray menu.
- **Quick Settings tiles and a home-screen widget** on the phone: send the latest photo or the clipboard in one tap.
- **Several phones and PCs.** The PC keeps up to four phones connected and you choose which one gets what you send.
  The phone switches between paired PCs with a tap on the PC button.
- **Phone notifications on the PC** (off until you turn it on on the phone and give Flick notification access), with
  a list on the PC to mute apps.
- **Two-way folder sync.** Pick a folder on the phone and it stays in sync with a folder in Flick Sync on the PC.
  Nothing is ever deleted: when both sides changed the same file, both versions are kept.
- **Media remote and Find my phone.** Play, pause, skip and change the PC's volume from the phone; make a lost phone
  ring at full volume from the PC.
- **Quick Share.** Turn it on in the PC's Flick window and the PC shows up in Android's own Quick Share menu; it asks
  before accepting and shows the same code as the phone.
- **Encrypted and paired.** Everything between the phone and the PC is encrypted, and the phone talks only to the PC
  it paired with. When you pair, both screens show the same 6-digit code: click Allow on the PC and tap Same code on
  the phone.
- **Updates itself.** The PC and the phone check GitHub for new versions and install them (the phone asks for one tap).
  Every release is signed with a key that is kept off GitHub, and Flick installs only updates that carry it.

With Stay connected in the background turned on (phone Settings), links, the clipboard and Find my phone also work
while Flick is closed on the phone.

Needs Windows 10 or 11 (64-bit) and Android 9 or newer.
