# Changes

## 2.0.0

The biggest update yet. In short:

- **Air grab.** Move files between your phone and your PC with your hand.
- **New animations with sound.** Meteor, Volt, Warp and Glitch, or Surprise me for a different one each time.
- **Faster transfers.** In tests, a single photo arrives in about 40% less time.
- **A send shortcut.** Select files on the PC and press Ctrl+Alt+F (Command-Option-F on a Mac).
- **A buzz in your hand when the file lands**, a volume slider, and Reduce effects for a lighter version.

Everything that changed:

- **New animations, each with its own sound.** Meteor catches fire and crashes down, Volt jumps across on lightning,
  Warp flies out of a tunnel of light and Glitch skips across like a broken signal; Surprise me picks one for each
  file. Files sent to the phone leave the PC the same way, and come in on the phone as they leave. The sounds are
  played whole and timed so their peak is the moment the card lands. Meteor is the new default: Roadster, Liquid,
  Teleport and Halo are gone (a PC set to one of them plays Meteor).
- **Volume and Reduce effects.** Flick's window has a volume slider (a little quieter than before to start with) and
  Reduce effects, a lighter version of the animations. A PC that can't keep up switches to it by itself.
- **The phone thuds when the file lands.** A short knock in your hand as the card hits the PC's desktop (Settings >
  Vibration turns it off with the other vibrations).
- **Send with a keyboard shortcut.** Select files in File Explorer, on the desktop or in Finder and press Ctrl+Alt+F
  (Command-Option-F on a Mac) to send them to the phone. On Linux, copy them first (Ctrl+C); under Wayland, add the
  keys as a custom shortcut in your system's keyboard settings (Flick's window shows the command). It can be turned off
  in Flick's window (Files).
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
- **Air grab aims where you meant.** A hand moves a little as it closes or opens: the file grabbed is the one your
  hand was over just before it closed, and a file lands on the PC where your hand was just before it opened. The
  light stays on a file until your hand is clearly over the next one, a still hand no longer jitters and a quick one
  no longer lags behind, and the card on the PC follows your hand more closely. A fist that comes in half closed
  still catches files from the PC, and right after a throw the same hand can grab again without leaving the camera's
  view. On the PC, hand tracking loads ahead of time while a phone is ready, so the camera follows your hand sooner.
- **Air grab holds on better.** A fist that slows down or loosens as it travels is still followed, and a file lands
  where your hand opens even when the camera loses it mid-opening; a hand whose first frame only looks open no longer
  drops or picks up anything. The tracker no longer jumps to your other hand (the one holding the phone, say), and a
  fist held still over the phone is found again at once instead of the file being sent. Opening your hand over the
  phone when nothing is held on the PC no longer buzzes or shows a hint every time. Right after a hand leaves the
  phone's camera, the phone no longer redraws the same camera picture thousands of times a second. Files picked up on
  the PC show in your hand at once (their picture follows). Selecting files on the PC for other reasons keeps its
  camera on 20 seconds at most in any 2 minutes, so the camera is there when you grab on the phone. The hand tracker's
  memory is freed when Air grab is turned off.
- **Air grab is safer and steadier.** The phone's camera stays off while Lock Flick is on, so a hand can't pick files
  up behind it, and while the PC's Flick is too old for Air grab (the phone says to update it). A hand counts as open
  only once it clearly is, so it no longer grabs or catches by mistake. If the phone's camera stops by itself while a
  fist holds files, they go back; a hand the camera loses as it opens still puts back, catches or lands where it
  opened. Turning the PC's camera off in Flick's window stops it at once, and a PC camera that fails no longer leaves a
  card frozen in the air. A fist bringing files from the PC can rest over the phone as long as it likes before it
  opens. With two phones, the other one hears when files were caught. On a Mac that doesn't let Flick ask Finder what's
  selected, the phone says where to allow it. On Windows, Flick no longer restarts its selection watching each time
  the phone shows another app.
- **Air grab, offered once.** After your first few flicks, the phone offers to turn Air grab on.
- **Faster transfers.** The phone keeps its encrypted connections to the PC open between requests, so a send no longer
  pays for a new handshake on every file and check (in tests, a single photo arrived in about 40% less time), and a
  fresh send skips a round trip it didn't need. The PC checks for files it already has, and for free space, much
  faster (a few milliseconds for 2,000 files instead of most of a second) and writes many small files faster. On
  Windows, a large file coming in several parts no longer stalls at the start while Windows fills it with zeros
  (seconds for a big video on a hard drive). On Android 10 and newer, the phone keeps Wi-Fi in its low-latency mode
  while files move. Files from the PC start downloading the moment the PC offers them (not when their card lands),
  and the PC offers a batch without waiting for each file's picture.
- **Transfers hold up better.** A PC drive that fills up stops a send with "Not enough space" (it was sent again and
  again), and a PC that keeps refusing a send ends it after a few tries instead of for ever. Thousands of files picked
  one by one go through without freezing the PC; files offered to the phone in a big batch no longer run out of time
  before the phone fetches them; a file from the PC carries on after a cut, also over one connection (Bluetooth). A
  file whose check on the PC fails for a reason other than damage is sent again (it said "Canceled on PC"), and a
  file is never announced twice. With the PC's Wi-Fi not connected to the internet and mobile data on, the phone still
  reaches the PC over that Wi-Fi; transfers never go through a network's HTTP proxy; over Bluetooth a send goes on one
  connection, so it isn't cut. "Skip files already on the PC" waits for a slow lookup instead of sending everything.
  Received names can't hide their type with invisible characters, fit the drive on Mac and Linux, and avoid every
  spelling of Windows' device names. Many small files go over several connections at once (in tests, 2,000 files to a
  PC slow to close each one, as with antivirus software, took a third of the time); Pause then Resume carries on at
  once; carrying on after a cut no longer reads again what the PC already has.
- **Smoother on the phone.** Coming back to Flick no longer freezes while the clipboard is checked; a big folder opens
  without stalling, and a tab, folder or search only waits for the listing on screen; thumbnails are made newest
  first (after a fast scroll, the cards you can see come first) and their cache stays under 192 MB; a lifted card
  follows your finger at once; removing files from the Flick list is instant; a batch of files from the PC and a big
  send coming back into the grid arrive without jank; the Transfers page updates in place.
- **Lighter on the PC.** The animation overlay only draws what changed; settings and history are written in the
  background; a picture left on the clipboard isn't read again every second; received Quick Share files are written
  in the background.
- **Saving on the PC.** With the save folder on another drive than the system's temp folder, incoming files are put
  together on that drive (saving is a rename, and the free-space check looks at the right drive). A received file that
  can't be put in place (locked by another program, say) is kept in a "Not saved" folder and you're told where,
  never deleted. Updates wait while files move.
- Fixed: a send canceled while it was waiting for the PC could still go through, and a pause tapped while a try was
  failing could be lost.
- Fixed: a send that was only waiting for the PC (or paused) kept the phone from switching PC, moving to a USB cable
  or turning Bluetooth off; the PC's edge glow could stay on after a lost link; a send whose
  "saved" note was lost with the link stayed in the list; a drag in progress was lost when the link moved; a photo
  swiped to quickly in the preview stayed blurry; a file thrown from the phone that was waiting its turn could be
  failed on the PC; effects that came while the PC took its desktop picture could be missed.
- Security: the phone takes a shared file:// address only from shared storage (never Flick's own files, Android/data
  or Android/obb), and Browse phone only takes a MediaStore id that matches its file; on the PC, the settings panel's
  messages are taken only from the panel, and a drop only from the drop window.
- **Phone fixes.** On Android 11 and newer the keyboard no longer covers what you type. Long messages show whole (and
  screen readers read them). Names with emoji or in Hebrew or Arabic show as they are, in file names, folder paths and
  what you type. A tap made while Flick is busy for a moment still counts. A long PC name no longer pushes ••• off the
  screen, menus and the pairing code fit short windows (split screen, foldables), and turning or unfolding the phone
  keeps your place in a big folder. Settings shows the connection as it is now, and coming back to Flick notices a
  dead link at once. Select all no longer takes a Flick-list file already on its way to the PC (it was sent twice),
  and such a file no longer comes back after changing tabs. A PC named with an apostrophe ("Mani's PC") shows right.
  Connect, folders and file menus work with TalkBack or a keyboard; Enter connects in "Enter PC address"; Back stops
  Find my phone's ringing even with a menu open, and opening Flick while it rings shows Stop. On Android 13 and newer,
  Settings says how to allow notification access when Android calls it a restricted setting.
- **More phone fixes.** Updates from the PC and the Bluetooth link work on networks with a proxy (and the pairing key
  no longer goes to the proxy). Auto-send keeps up on a busy day (it stalled after 200 new photos in 6 hours). Two
  synced folders with the same name (DCIM's and Pictures' Screenshots) no longer share one folder on the PC. Opening
  Phone storage no longer reads every photo on the phone. A damaged file whose thumbnail crashes Flick can't close it
  again and again. Sharing a big file to Flick says it's on its way, and one Flick can't take says so. With Android
  System WebView missing or updating, Flick says so instead of closing. Turning on bold text no longer restarts
  Flick's screen (or a transfer over Bluetooth). Moving to a new phone (Android 12 and newer) no longer copies Flick's
  pairing keys and identity: pair the new phone, as before Android 12.
- **PC fixes.** On Windows, Flick's notifications show (its app id is registered). The overlay's sound stops running
  once nothing plays (the PC was 20 times busier at rest after the first sound). Received files with long names in
  other scripts fit Mac and Linux, a name is never cut through an emoji, and every spelling of Windows' device names
  is renamed. Sending more than 100 files at once says only the first 100 went, and files picked for a phone that
  never came say so. A second start of Flick no longer breaks an update being unpacked, and no update restarts Flick
  while a Quick Share waits for an answer. The overlay keeps drawing after two graphics resets in a row, a landed
  file's label shows the name it was saved under, and stopping the PC's own Wi-Fi while it starts leaves it off.
- **Quick Share on the PC.** The question opens on Decline and Accept ignores a click for its first second, so a
  keystroke meant for another app can't accept a stranger's files. Files that can't be saved are kept in "Not saved"
  and you're told (they were lost), a share that can't be taken in is declined instead of left hanging, and "Open
  files when they arrive" opens only pictures, videos, music, PDFs and text from it. Disk images are never opened.

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
