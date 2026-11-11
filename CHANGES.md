# Changes

## 2.1.0

**Updating from Flick 2.0.0 or older: install this version yourself, once.** Download it from this page and install it
over the one you have, on the computer and on the phone. Flick's releases are signed with a new key from this version
on, and Flick 2.0.0 and older don't know it, so they can't take this update by themselves. From 2.1.0 on, updates
arrive as before. Your pairings and settings stay.

Send to any of your devices, any way they're connected. In short:

- **Phone to phone and computer to computer**, with everything Flick does between a phone and a PC.
- **One Connect button.** Hold it on one device; the other asks to allow it; tap Same code and they're paired.
- **No shared Wi-Fi needed.** Phones find each other over Bluetooth, and big files switch to Wi-Fi Direct by
  themselves; a computer can make a Wi-Fi network for a phone; USB cables work too.
- **See every transfer**: in the phone's notifications and Settings, and at the top of Flick's window on the computer.
- **Simpler for new users.** Settings shows the everyday settings; the rest is under Advanced settings. A new install
  starts with the animations off and opens with a short tour of the real buttons.

Everything that changed:

- **A simpler layout.** On the PC, Flick's window has a bar at the bottom with Home, Devices, History and Settings
  (Ctrl+1 to 4; Esc steps back). Home follows the connection: Connect while nothing is connected, a big send area once
  something is (Devices > Connect a device brings Connect back), and Browse your phone, Share with a browser and
  Clipboard history can each be hidden from it (Settings > Help > Show hidden cards on Home). When Connect finds
  nothing it asks **Can't find your phone?**: Use this PC's Wi-Fi (was "Phone on another Wi-Fi?"), Use a USB cable,
  or Same Wi-Fi, still nothing? (the firewall fix); the Wi-Fi code keeps the network's name and password behind
  "Can't scan?". Paired phones moved to Devices, and What's new to the top of Settings. On the phone, the ••• menu
  starts with Other phones, History and Settings as tiles. On both, Advanced settings is a page of its own, and the
  tour shows once more to a user updating, since the window looks different.
- **Simple settings, with Advanced settings.** On the PC and the phone, Settings shows what most people change: where
  received files go, the device's name, starting with the computer (PC), notifications, updates, and the paired phones
  with Always accept or Ask each time (PC). Everything else, every animation and effect option included, is under
  **Advanced settings**, a page of its own whose label names what's in it
  (animations, Air grab, clipboard sync…). Check now and the version are in there too, and the phone's Transfers
  section shows only while something moves or moved lately. The phone's ••• menu no longer has Animation: it's in
  Settings > Advanced settings, with the switch that turns the animations on.
- **Animations off on a new install.** A new install starts with the animations off (PC: no settings file yet; phone:
  installed and never updated, with nothing kept yet). Settings and installs from an older Flick keep them on.
  Settings > Advanced settings > Animations turns them on. With them off the PC takes the plain way it already takes on
  a Linux desktop without compositing: no overlay, the corner card shows each transfer as it ends, hints go in the
  window's note or a notification, and a file saved or one that didn't arrive is a notification when the card is
  turned off and the window is closed. On the phone the full-screen effects, the Connect screen's spinning glow and
  the animations' sounds stay off; the edge's short glow still says a file went.
- **A first-time tour.** The first time Flick opens after a new install, on the PC and the phone, the screen dims and
  each real button is lit in turn, with an arrow and a line on what it does: Connect, sending files, Transfers, your
  devices, History, Settings and Advanced settings ("Step N of M", Back, Next, Skip, Done; on the phone it opens the
  ••• menu and Settings to show what's in them). Its last step has **Turn on animations** while they're off. It shows once; **Show the tour again** in Settings brings it back.
  Esc (or the phone's Back) skips it, Tab stays in it, a screen reader hears it as a dialog, and at large text its
  words scroll so the buttons stay in sight. A device asking to pair, and files waiting for Accept, come on top of it.
  The phone's tour uses nothing newer than Android 9's WebView (Chromium 66).

- **One Connect button.** Hold Connect on any device, a phone or a computer, and the other one asks its user to allow
  it, with the same code on both screens; once it's allowed there, the device you held asks whether it's the same code,
  and Same code pairs both (so a stranger's device answering first can't pair with yours; a phone held over a USB
  cable has nothing more to tap). Flick works out which device you mean: the only one nearby, else the one on a cable,
  else the one with Flick's Connect screen (or window) open; otherwise it lists them to pick from. The phone's first screen no
  longer asks whether you're connecting a PC or a phone: it says what's nearby, and when the only device there can't
  be paired (it's paired already, or has an older Flick), it says so.
- **Phones that aren't on the same Wi-Fi.** Holding Connect finds phones nearby over Bluetooth too (Android 10 and
  newer; the first time, Flick asks to find nearby devices, and offers to turn Bluetooth on when it's off; on Android
  10 and 11 it says when Location has to be on for it). Paired that way, they send files, the clipboard and links and
  find each other over Bluetooth, encrypted end to end as over Wi-Fi, and a paired phone that isn't on the network is
  reached that way by itself (with Stay connected in the background on there, also while Flick is closed on it). What
  a phone sends over Bluetooth changes every 15 minutes and only its paired phones can tell it's theirs, so it can't
  be used to follow anyone; while Flick isn't on screen, a phone says nothing about itself to phones it isn't paired
  with. Bluetooth is slow for files, so big ones switch to Wi-Fi Direct by themselves: the phone taking them makes a
  Wi-Fi network of its own for a moment and the other joins it, with nothing to tap (Wi-Fi on; Android 13 and newer,
  or 10 and 11). Otherwise they go over Bluetooth.
- **A phone on another Wi-Fi than the computer.** When Connect on the computer can't reach it (nothing found,
  another device found instead, or one that needs a newer Flick), Phone on another Wi-Fi?
  makes the computer's own Wi-Fi network (Windows and Linux) and shows its code: the phone's camera joins it, and once
  Flick is open on the phone, it's asked by itself. The network goes once the phone is no longer connected over it.
- **USB cables.** Plugged into a computer, the phone says "USB connected" at once; with USB tethering on (one tap
  opens its switch) the computer answers over the cable within a second and both say "USB connected. Ready to
  transfer." Two phones on one USB-C cable pair and send to each other over it, no network needed (Android asks once
  on each phone to open Flick). Two computers on a USB4 or Thunderbolt cable, or a transfer cable, show it as USB
  cable.
- **Everything between any two devices.** A file flicked from one phone to another, or sent from one computer to
  another, leaves in the sender's animation and lands on the other device in the same one, with its sound. Send
  clipboard puts it on another device's clipboard; a link shared to Flick opens on any of your devices (shown there to
  open, never opened by itself); Find makes another phone ring until it's found. Ask each time works on phones too,
  with Accept and Decline in Flick or in the notification. With Stay connected in the background on, a phone takes
  files from your other devices while Flick is closed. The phone's connection button says where flicks go and switches
  between the PC and paired phones; a computer's window has Send to.
- **Transfers on the phone.** Each transfer is its own notification, as with Bluetooth: the file's name, the other
  device, how far it got and a progress bar, with Cancel; one that ends while Flick isn't on screen leaves a short
  note. Settings starts with Transfers: what's moving now, both ways, with how far each got and Cancel; See all
  transfers lists what moved lately. Cancel works on files coming in from another phone too.
- **Transfers on the computer.** The top of Flick's window lists what's moving between this computer and its phones,
  other computers and browsers, both ways, with how far each got and Cancel; while the window is closed, a small card
  in the corner of the screen shows it, and the taskbar (the Dock) shows how far it all got. A Cancel on either device
  says Canceled on both.
- **Phone to phone.** Phones with Flick pair once and send files and whole folders to each other, with no PC needed:
  ••• > Other phones (also on the screen for connecting to the PC). Both phones need Flick open (or Stay connected in
  the background on the one taking them), on the same Wi-Fi, on a cable, or nearby over Bluetooth. A file's menu has
  Send to <phone>; with files selected, there's a phone button next to Send (on a phone never paired with a PC, Send
  itself goes to the phone); Send on the Other phones page opens Android's pickers or lets you choose in Flick. What
  arrives shows at the top of the view, with a picture of it while it comes, and goes to Download/Flick (or into the
  Flick list, with a copy in Pictures, Movies, Music or Download, when Flick can't see the phone's files). History
  shows these transfers (also one that ends while Flick is closed or reloading), and Send again goes back to that
  phone.
- **PC to PC.** Your other computers with Flick show up in Flick's window under Your other devices. Pair once with a
  code, then drop files or folders on a computer in the list (or use Send files / Send a folder): the card leaves one
  screen and lands on the other. Ask each time works for them as for a phone. A computer with Flick 2.0 is listed as
  needing an update instead of offering to pair (it can't take files from other computers).
- **One list of your devices on the PC.** Your other devices also lists this PC's phones: connected ones have Send
  files, and files dropped on a phone go to that phone, even when it isn't the one in use.
- **Pairing** goes both ways at once, and Remove on either device unpairs both (and stops anything on its way). Each
  side commits to its half of the code before either says it, and the device asked says its half only once the request
  is on its screen: nobody can steer the code, or try code after code unseen. A pairing allowed on one device counts
  once the device that asked has confirmed it too (its user taps Same code; until then the other says "Waiting for …
  to confirm the code there"), and when a device paired already asks again, the question says so. Remove right after
  Allow is heard on the other device too. A device paired only
  one way (the pairing wasn't finished on the other one) is listed, on phones too, so it can be paired fully or
  removed. A device renamed shows its new name on the devices paired with it. Everything is encrypted with each
  device's own certificate, pinned when pairing, as between phone and PC.
- **A send says what happened.** No room on the other device, too many sends at once, files that couldn't be read
  (changed or gone since they were picked) and folders more than 62 levels deep are each said, and what did go is
  counted. A send whose last answer got lost says it went but wasn't confirmed. Cancel stops a send at once, even
  while connecting; at 100% the files are there already and it ends as sent. Every step has a time limit: a device
  that stops answering ends the send instead of leaving it "sending". A send that didn't go is in History too (on the PC,
  with a notification unless the window is showing Your other devices).
- Fixed: Flick's window could miss the first state of some of its pages right after it opened.
- Fixed: a copy into the phone's public folders that couldn't finish no longer leaves a half-written file behind.
- Fixed: a file or folder whose name starts with a dot no longer lands hidden on a Mac or Linux computer: it arrives as
  `_notes.txt` instead of `.notes.txt` (names inside a folder are kept as they are).
- Fixed: any device on the network could make Flick on the PC take more and more memory by sending it pings and never
  reading the answers.
- Fixed: connections closed the moment they opened weren't counted as closed: after a few, that address couldn't
  connect to the PC until Flick restarted.
- Fixed: setting the computer's clock forward dropped every connection.
- Fixed: a file or folder with a very long name (tens of thousands of characters) could freeze Flick on the PC.
- Fixed: a file and a folder whose names differ only in case ("Notes" and "notes") made the whole folder fail to arrive
  on Windows or a Mac.
- Fixed: on Windows, a received name could still be one Explorer can't open or delete: one ending in a dot and an
  unusual space, or a very long one that, shortened, became a name Windows keeps for devices (like `nul.txt`).
- Fixed: on Windows, Flick's button on the taskbar could show a blank page instead of Flick's icon.
- Fixed: Mark of the Web covers every file of a received folder, not only the first 5,000.
- Fixed: with Ask each time, Accept saves only what the question showed: anything else is asked about again.
- Fixed: canceling transfers that don't exist can no longer make Flick on the PC take more and more memory.
- Fixed: names other devices send can no longer add lines of their own to Flick's log, or turn the words around them
  backwards.
- Fixed: a card's picture from a phone is shown only when it's a small picture sent with it.
- Fixed: a transfer cut short by quitting Flick on the PC no longer leaves its partial file in the temp folder, and one
  cut short by a crash is cleared within minutes of the next start, not hours.
- Fixed: links sent from the PC with capital letters in their start (HTTPS://, Http://) open in the phone's browser.
- Fixed: a Cancel between phones over Bluetooth ends on the other phone in under a second (it took several seconds), and
  that phone says the sender stopped sending instead of that it couldn't receive the file; over Bluetooth to a PC, an
  upload the PC stops no longer holds up the phone's other requests for seconds.
- Fixed: when another program holds Flick's port as the PC starts, Flick takes its own port back once it's free and its
  discovery answers again; on Linux, Fix it gives a firewall rule for every port Flick may use (47860 to 47865); the
  phone no longer says the PC has a new security key, but finds Flick on the port it moved to.
- Fixed: a file from the phone whose last part could not be written to the PC's disk (a full disk, a quota) was
  said to have arrived, and kept cut short. It now says it did not arrive, and why.
- Fixed: a phone removed from another phone's devices could, over a connection it had opened before, still send
  that phone its clipboard, links and Find rings (never files).
- Fixed: connections that never shared anything could take every place Quick Share has on the PC, so a phone's
  share was refused until Flick was started again.
- Fixed, on the PC: a note from Flick shows on every page, just above the bar, not only on Home; with a phone on this
  PC's own Wi-Fi network, Home keeps the line that says so, with Turn it off; holding Connect again with a phone
  connected no longer hides the Connect card under the press; Escape no longer closes a page behind an open question;
  "Can't find your phone?" offers Bluetooth only on Windows; when Bluetooth or Quick Share can't start, there is an
  Open the log link; a setting changed the instant before quitting is kept; Flick doesn't restart for an update while
  this PC's own Wi-Fi network is on (for up to 6 hours); a Quick Share request the phone takes back stops the taskbar
  button flashing; on Linux, stopping this PC's Wi-Fi network no longer deletes a connection of your own named "Flick".
- Fixed, on the PC: a file sent quietly (auto-send, the tile, the widget) stops when its phone is removed, and no other
  phone can replace or cancel it; folder sync judges free space by the drive the synced folder is on; pairing with a
  computer that closed the moment it allowed the request fails at once instead of leaving a one-sided pairing; when a
  device with Flick 1.8.0 or older asks to pair, the window says it needs a newer Flick.
- Fixed, on the phone: with Animations off a file's card comes and goes plainly (no glow, stretch or thud); Settings
  shows the animation just chosen; a quick second Back while Settings closes no longer goes a folder up; a PC that
  can't be verified is retried every 20 seconds and said once; two files arriving close together both play their
  sound; a file from another phone that stopped because Flick was closed there says so; the tour waits for an open
  page, ends on the files when a PC connected meanwhile, and shows a pairing code that came during it as soon as it
  ends; stopping a synced folder right after Sync again leaves no "Setting up…" row; Lock Flick is under Security.
- Fixed, on the phone: pairings are no longer lost when their list couldn't be read once at start; a clipboard picture
  goes to another phone over Bluetooth; a Bluetooth link stays two minutes after a long send; Sync now pressed at the
  wrong moment no longer stops a folder syncing; pairing again keeps Ask each time; a pairing allowed but never
  confirmed doesn't stay after a restart; a transfer's notification updates once per percent; the report screen after a
  crash is clear of the status and navigation bars on Android 15 and newer; a new install that Android updated before
  it was first opened still starts as new.
- Fixed, older Android (System WebView 66 to 85): the Connect screen's glow shows, long names without spaces wrap,
  wrapped rows keep their spacing at large text, and the keyboard's focus ring shows on switches.
- The Mac app needs macOS 13 or newer, and says so on an older Mac.
- Fixed: turning Quick Share off, or quitting Flick, takes the PC off phones' Quick Share lists at once.
- Fixed: a switch in Flick's window clicked again quickly while the PC is busy no longer jumps back or ends the wrong way.
- Fixed: a certificate, settings, History, clipboard history or feedback file briefly held by an antivirus or backup
  program as the PC starts no longer gives the PC a new security key (every phone and computer pairing again) or forgets
  pairings and settings: Flick waits, writes nothing over them, and picks them up once they can be read; encrypted
  links then turn on by themselves with the same key. A damaged settings file is kept as settings.json.damaged.
- Fixed: on the PC, keys, History, the list of files already received and the current update are saved so a power cut
  can't leave them half-written; a clock set back no longer holds up update checks; feedback the form refused is still
  offered after a restart; clipboard files a crash left behind are cleaned up.
- Fixed: on the phone, Flick Sync of Download/Flick no longer mixes up a file arriving from the PC with a file of the
  same name being synced; no invisible files are left in Flick's storage when it's closed while files arrive or while
  the Flick list is cleared; History, pairings, sync records and auto-send's memory survive a power cut; a transfer made
  while the clock is behind stays in History; auto-send no longer misses photos after the clock is set back.
- Fixed: a file from the PC that arrives while you're in a folder or another tab no longer shows up in that folder:
  it's in the Flick tab and Recent, and Flick says it's coming and that it arrived. The phone's Sending % no longer
  drops back when one of several sends finishes or after a short wait for the PC, nor jumps ahead when one is
  canceled, and a quick double tap on Settings' Back no longer goes up a folder.
- Fixed: on a phone whose Android System WebView is older than Chromium 87, Flick's screens show and work again, and
  Flick says once to update Android System WebView.
- Fixed: on the PC, Windows' contrast themes show whether switches are on and how far transfers are; the edge of the
  screen takes dragged files again on its own after a crash; names written with joiners (Persian words, emoji like
  👨‍👩‍👧‍👦) show as they are; the keyboard keeps its place in Paired phones and when Transfers empties; a
  double-click on Send to phone in History sends the file once.
- Fixed: a phone that stops fetching a file mid-way no longer keeps the PC from updating itself; Share with a browser no
  longer fills up for good with browsers that left, and says so when it's really full; after the PC's or the phone's
  clock is changed, Quick Share, nearby devices, "Don't allow" pauses, waiting sends and the background link carry on
  normally; on Linux, a program that quits or hangs while Flick reads the clipboard no longer leaves the send shortcut,
  Air grab and clipboard sync dead until Flick restarts.
- Fixed: on the phone, Cancel and Pause take effect at once while a send asks the PC what it already has, looks for it
  or connects, and an unanswered question no longer makes the send copy files the PC already has.
- Easier to use with a screen reader, keyboard or voice control. On the PC: screen readers, Narrator, VoiceOver and
  voice control can press Connect (a quick mouse click still asks to hold it); each view is read by its name with its
  title as a heading, and sliders say what they're set to; the window zooms up to 200% with Ctrl+Plus, Ctrl+Minus,
  Ctrl+0 (Command on a Mac) and Ctrl+mouse wheel and keeps the size; Flick follows the system's reduce motion setting
  until Reduce effects is set by hand; the browser page says whether files were sent and which files the PC shared. On
  the phone: a menu keeps you inside it until it closes, then puts you back where you were, and what's behind it can't
  be pressed through it; a screen reader hears "Sent <file> to <PC>" when a file reaches the PC, what holding Connect
  will do, when a device turns up, and when a send to another phone fails; each group of choices is one Tab stop that
  the arrow keys move through; most small buttons take taps in a bigger area without changing how they look.
- Quit Flick on the PC asks first while files are still moving. On the phone, removing another phone or a file from
  the Flick list asks first, with the keyboard starting on Cancel.
- Easier to read: text on accent-colored buttons with every Windows accent color, the PC's version line and the
  browser page's Sent and placeholder text, the phone's Disconnect, and Send feedback's note and email example. With
  Remove animations on, the phone no longer plays the full-screen flick effects and the Animation previews stand
  still. Ways to connect's steps stay up long enough to read, and the next tap puts them away.
- Fixed: a file saved again on the PC while the phone downloads it is no longer kept on the phone as a mix of two
  versions: the PC refuses it, the phone says it changed on the PC, and the PC's Transfers says to send it again. In a
  batch from the PC, the phone's note that a file couldn't be received or changed is no longer covered at once by
  the batch's own "Saved" note.
- Fixed: folder sync with a Mac no longer sends accented file names back and forth or keeps them twice on the phone,
  and two different files with the same accented name are both kept. Files you receive whose name ends in .flickpart
  are shown and no longer deleted a day later.
- Fixed: text over 1 MB on the phone's clipboard is no longer sent cut short without a word: Send clipboard, the tile
  and the widget say it's too much text to send, and clipboard sync skips it. A clipboard of only spaces or invisible
  characters shows as "Blank text (N characters)" in Clipboard history on the phone and the PC. An update that stops
  because the phone's storage is full says so, instead of that the PC or GitHub couldn't be reached.
- Fixed: a folder sent to the phone or shared with a browser no longer follows links inside it (a link to the folder
  itself sent each file up to 7 times), and files more than 6 folders down are said to be left out. Share with a
  browser takes more than 10,000 files in one pick as whole batches, and says "Only the first 200 files are shared"
  when files past its limit are left out. Send a link takes a link with a space in it, and says a link over 4,096
  characters is too long to send instead of calling it not a web link. A settings file holding values of the wrong
  kind no longer shows "Invalid Date" or "[object Object]", and History shows a time ahead of the PC's clock as its
  date instead of "just now".
- Fixed: a web page or another app on the phone could reach the paired PC through Flick's encrypted or Bluetooth
  link, and another app could pick up Flick's sign-in to the PC from a link Flick had closed.
- Fixed: a device on the network could make Flick on the PC run out of memory and close, make it send far more than it
  was asked over the network announcement, or keep connections and Bluetooth links open without end.
- Fixed: Open files when they arrive, Open in History and a click on a received file's notification no longer open
  scripts (on Windows too): anything that isn't a picture, video, music, document or text is shown in its folder. On
  Windows, Flick runs the system's own tools by their full path. Once Flick is installed with the 2.1 installer, its
  program no longer lets another program run its own code under Flick's name.
- Fixed: a phone asking to sync a folder could be given another phone's Flick Sync folder.
- Fixed: auto-send carries on where a send was cut off instead of sending the whole file again, and never leaves a
  second copy on the PC. Updates Flick fetches from GitHub by itself wait for Wi-Fi instead of using mobile data.
- Fixed: Flick's screen follows Android's font size. Select all in a big category selects every file in it; a view
  the phone couldn't list says so instead of "This folder is empty"; Clear the Flick list asks first and keeps files
  still on their way to the PC. TalkBack names each switch and choice, and a keyboard reaches the toolbar and selects
  files with Space.
- Fixed: the Send clipboard tile and widget stalled on Android 14 and 15; clipboard history (on the phone and the PC)
  showed a broken character when a preview ended inside an emoji.
- Fixed: Share with a browser deleted an upload the save folder wouldn't take, and cut off a big file that took more
  than a minute to save (Retry then sent it again); a file cut off by Disconnect can be sent again.
- Fixed: on the PC, Check now says what it found; Save files to keeps a folder of your own in its list; files picked
  with Send files while the phone was away wait for it instead of being dropped; Remove asks once more, as Clear does.
  On Linux, files copied in the file manager no longer go to the phone's clipboard as text.
- Fixed: a link with a name before the site (https://bank.example@evil.example, which opens evil.example) is no longer
  opened, shown as a link or offered to send, on the phone or the PC.
- Fixed: Share with a browser takes up to its 200 files from one pick or drop (a drop stopped at 100) and gives one
  note for the limit that cut it; a file given twice (a folder and a file in it) is sent or shared once. A device
  named only with invisible characters shows as PC, Phone or another phone instead of a blank.
- Fixed: a device on the network that never paired could fill every connection to the PC and keep paired phones,
  computers and browsers out; now its connections make room, and those of signed-in devices are never closed for it.
  The PC's discovery answered anyone, from anywhere, as often as asked, and said which devices were paired with it; it
  now answers only its own networks, a few times a second to each device, and no longer says who is paired.
- Fixed (Linux): a file or folder received into a save folder other accounts can write in could be used by one of
  them to open up the rest of your files; it now gets its usual permissions before it's put in place, and an item
  that can't be put there safely is kept in Not saved, with the reason.
- Fixed: a link another phone sends, or one shared to Flick, shows its site as the browser will open it: a name that
  copies a known site in another script shows as xn--…, as on the PC, the end of a long site name is never cut off,
  and a shared link's menu is headed by its address. On Linux, Flick's notifications show phone notifications, file
  names and links as plain text.
- Fixed: a file's menu opened while typing a search leaves the search field and its keyboard in place.
- Fixed: History in the computer's window no longer stutters while files arrive: only new and changed entries are drawn
  again.
- Fixed: half-received files left in a synced folder when the computer stopped in the middle of a sync (Flick closed by
  force, a power cut) are cleared away an hour later, the next time the phone syncs that folder.
- Fixed: the phone's History and Transfers show times in the phone's current time zone and language after either
  changes, without reopening Flick.
- Fixed: on the computer, a device's "Remove?" goes back to "Remove" after 4 seconds even if the device's row was drawn
  again meanwhile (for example when it went out of reach).
- Fixed: a phone that stops reading a file it is syncing (app frozen, phone asleep) is let go after a while, like any
  other download, so automatic updates no longer wait for it forever.
- Fixed: a copy from Browse phone that stopped, and a stuck Bluetooth stream, end on time even after the computer's
  clock is set back, and a clock set ahead no longer cuts a healthy one.
- Fixed: in Browse phone, Copy to PC, Stop and Close no longer drop the keyboard to the top of the computer's window,
  and a screen reader hears that a copy started and how it ended once, instead of every file.
- Fixed: Clear all in History and Clipboard history, and removing a device in Your other devices, keep the keyboard in
  the view.
- Fixed: a phone's sync of a file with a long name in Chinese, Japanese, Korean, Thai or Hindi now arrives on a Linux or
  Mac PC, and when the PC's copy of a long-named file is newer, the phone's copy is kept beside it under a shortened
  name, instead of failing every sync.
- Fixed: on the computer, Connect no longer stays on "Looking for devices nearby…" (or keeps its own Wi-Fi network on)
  for an hour when the clock is set back, and no longer cancels in the middle of pairing when it is set ahead.
- Fixed: after the computer's clock was set back, Transfers, the taskbar progress and the progress card stood still,
  and a long transfer from a phone could fail as stalled. A picture copied over another one is sent to the phone again
  after such a change.
- Fixed: after the phone's clock was changed with Flick open, the link to the PC could drop once, Looking for devices
  or a PC's refusal stayed on the Connect screen too long, and switching to another paired PC waited.
- Fixed: a file grabbed in the air whose upload never started stayed in Transfers and held back updates until Flick
  restarted.
- Fixed: on Windows, Phone can't connect? Fix it says Windows will ask to let Flick through its firewall, and
  afterwards whether it was allowed or not changed.
- Fixed: the computer's address in the Flick window is one the phone can type: 192.168.1.23:47861 when Flick took
  another port.
- Fixed: adding a synced folder on the phone says "Adding…" until the app takes it, and when the app refuses it, says
  why (for example "Flick can't write to this folder").
- Fixed: the phone's "Connect to" list says what to do for a computer on another Wi-Fi, and "Can't reach" a PC the
  phone still sees points to "Phone can't connect? Fix it" on the PC. Enter PC address takes an address with its port.
- Fixed: a file received from the PC while Android rebuilt Flick's screen in the background now appears in History,
  and Cancel stops a send to an older PC even after the screen was rebuilt.
- Fixed: folder sync never replaces a copy kept from an earlier conflict, a same-size edit from a phone whose clock is a
  second behind is no longer taken for the same file (the computer compares the content), and Stop syncing on the
  computer stays stopped (the phone shows "Stopped on <computer>" as a plain status, and Sync again in its menu starts it
  again).
- Fixed: an upload to an older computer canceled from the transfer list or the notification is canceled on that computer
  too.
- Fixed: folder sync no longer fetches back files sent to a computer folder that keeps coarser times (a FAT or exFAT
  drive, a Mac, a network share), and a folder whose sync record was lost is matched without fetching every file again.
- Fixed: Sync again on the phone is offered only for the computer the folder was synced with, and says "Adding…" until
  the app takes it; adding a folder already in the list says "Syncing" once it starts.
- Fixed: the phone's History names the computer a file came from even after switching computers while it arrived, and
  History cleared while its file couldn't be read stays cleared. A folder added again while the list of synced folders
  couldn't be read stays one synced folder.
- Fixed (Linux): on a desktop without compositing (Openbox, i3 and other tiling window managers, Xfce or MATE with
  compositing off), a flick no longer turns the whole screen black: Flick leaves out the animations there, shows hints
  in its window or as a notification, and draws the progress card and screen-edge strip solid.
- Fixed: a device that isn't paired can no longer keep a new phone from pairing (with a phone or a computer), or a
  paired one from signing in from a new address, by flooding it with bare connections: whoever keeps opening more loses
  its own connections first.
- Fixed: a device that isn't paired can no longer keep a phone busy by holding all its connections: each of its
  connections gets one answer, together they take at most half the places, and paired phones and computers can always
  send.
- Fixed: on phones with an older Android System WebView (Android 9's), Preview opens, Update starts its download, and
  Flick opened with a USB cable plugged in still connects to its PC and lists its sends.
- Fixed: on Windows, Phone can't connect? Fix it works when Flick's folder has a letter like the é in José, or an
  apostrophe, %, & and the like.
- Fixed: History, synced folders, the clipboard list and auto-send on the phone are no longer emptied when their file
  can't be read for a moment.
- Fixed: two phone folders of the same name synced with one computer in 2.0.0 (DCIM's and Pictures' Screenshots) get
  folders of their own on the computer; files already copied between them stay.
- Fixed: syncing a phone folder with a long Chinese or Japanese name when a folder of that name was already taken.
- Fixed: Check now, Send feedback and Start (this PC's Wi-Fi) on the computer, and Update and the media remote's keys on
  the phone, no longer drop the keyboard focus while they work.
- **Faster.** A phone paired with its PC opens straight on its files. On a PC without a graphics chip a thrown file's
  card shows at once (no photo of the screen it doesn't use). The phone's first screen shows sooner, and its file count
  no longer says "0 items" while the files are being listed. A PC that updated itself starts sooner. Flick on the PC
  starts lighter (the animations are set up when first needed) and its first window after login opens faster. Photo
  previews open faster and use far less memory (the full photo loads when you zoom in). Big folders scroll lighter on
  the phone, Transfers stays smooth with hundreds of transfers, and Browse phone stays quick in big folders. The
  installer is smaller.
- **Safer.** A website open in the PC's browser can't reach Flick's phone connection, and pairing without the code (no
  public version of Flick does that) is refused. A paired phone can't touch another phone's transfers. A crafted app
  file in Downloads can't crash Flick at start. On a Mac and Linux, settings (they hold pairing keys) and files still
  arriving are readable by you only; Linux keeps incoming files in ~/.cache/flick instead of the shared /tmp. Names
  and links can't hide what they are with invisible direction marks. Lock Flick also keeps keyboards out, and turning
  it off asks for the phone's lock. Crash reports leave out tokens and passwords. A nearby device can't keep pulling
  Flick to the front with Quick Share, and malformed shares are turned down without asking.
- Fixed: a send between computers over a slow network stopped at 100% and said it wasn't confirmed, with nothing saved;
  it finishes, and its progress shows what has arrived there. Phones sending to a PC over a slow link no longer start
  again or fail while the PC is still receiving.
- Fixed: folder sync of a folder with thousands of files said it couldn't reach the PC; one file whose name Windows
  can't take (like `10:30 notes.txt`) stopped the whole sync; the first sync replaced a different file with the same
  name, or a name that differs only in capitals, on the other side (both are now kept, as "name (from <device>)");
  removing a synced folder didn't stop its sync; very long names never arrived; temporary files were sent again on
  every run.
- Fixed: sends that finished while Flick was closed were missing from History; failed sends are listed too, and a send
  cut short by quitting Flick is in History on both computers.
- Fixed: a PC added with Enter PC address couldn't be paired by holding Connect.
- Fixed: between phones, with Ask each time, Cancel then Accept kept files the sender said were canceled, and a
  Cancel as the last bytes went could end differently on the two phones; both now agree. Wi-Fi Direct dropping in
  the middle of a send carries on over Bluetooth. A phone with Flick in the background no longer tells strangers its
  name, and a send past a phone's limit of sends a minute waits and goes by itself.
- Fixed: a paired phone that falls back to Connect after waiting for its PC says why (another phone is connected to
  it, or its Flick needs updating).
- Fixed: a phone the PC removed went on as if paired; it says so and shows Connect. After Don't allow, holding Connect
  again says "Try again in N s".
- Fixed: a renamed computer took minutes to show its new name on the computers paired with it.
- Fixed: a folder send left out items it couldn't read without a word, and names that aren't UTF-8.
- Fixed: files the PC couldn't save were kept in the temp folder, which the system empties; they're kept in Flick's
  own Not saved folder.
- Fixed: on Windows, uninstalling Flick installed into a folder of your choice removed that whole folder; a chosen
  folder now gets its own Flick folder, and uninstalling removes only that. Send with Flick shows for every account.
- Fixed: Quick Share shares of thousands of files failed; newer phones that list several encryption methods were
  turned away; the question stayed after the phone canceled.
- Fixed: Find my phone wouldn't ring for 2 minutes after the PC stopped it, and left the alarm volume at full if Flick
  was stopped mid-ring.
- Fixed: once Android stopped asking for a permission, its button did nothing (it opens Flick's settings now); a share
  made right after a crash was lost; with memory short, Flick rebuilt its screen in the background again and again.
- **More under Help.** On the phone: **Get Flick for your PC** (where to download it, and the link to send to the
  computer; also on the Connect screen until a PC is paired), **Privacy** (what Flick does with your files and data)
  and **Open-source notices** (what Flick is made with, and each license's text). On the PC: Open-source notices.
  Turning on Show notifications on your PC first says what Flick reads and where it goes.
- Fixed: updates to the PC app never arrived over slow connections.
- Fixed: on the phone and the PC, keyboards and screen readers lose their place no more when a screen redraws;
  questions are proper dialogs, controls are named, and Remove animations is respected. The PC's window fits short
  and scaled screens. Flick's entry in the share sheet is Send with Flick, since a share can go to a phone too.

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
  and such a file no longer comes back after changing tabs. A PC named with an apostrophe ("Alex's PC") shows right.
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
