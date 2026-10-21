# Changes

## 1.7.0

- Fixed: after a transfer, part of the animation could stay on the PC screen for minutes. Anything left on screen
  now clears itself, and a transfer that stops sending is reported as failed.
- Fixed: the "A JavaScript error occurred in the main process" box when a transfer was interrupted. A retried
  transfer now cleanly replaces the broken attempt, and unexpected errors are written to the log instead.
- Faster: large files travel over several connections at once in both directions, the phone keeps Wi-Fi power
  saving off while files move, and both screens show the transfer speed.
- More ways to connect: a USB cable (USB tethering) and the phone's hotspot are found by themselves, and Flick
  moves to the fastest link. Bluetooth works when there's no network at all (pair the phone and the PC first).
- Quick Share: turn it on in the PC's Flick window and the PC shows up in Android's own Quick Share menu when the
  phone is on the same Wi-Fi. The PC asks before accepting and shows the same 4-digit code as the phone; links and
  text go to the clipboard.
- Send from the PC to the phone: a "Send files to phone" button, dropping files on the Flick window, or right-click
  in File Explorer > Send to > Flick (phone). Folders work too, and files sent while the phone is away go out as
  soon as it connects.
- Settings: a Settings page on the phone (••• > Settings), and new options on the PC (open files when they arrive,
  show transfer speed, the Send to menu, connections, automatic updates).

## 1.6.0

- The phone app now checks GitHub for new versions by itself and downloads them from there, so it updates even when
  it isn't near the PC. Installing is still one tap (Android asks you to confirm).
- GitHub builds and signs the phone app for each release that changes it.

## 1.5.0

- Flick on the PC now updates itself from GitHub: when a new version is released, it downloads it in the
  background and restarts into it when it isn't busy. No installer or admin prompt needed.
- The phone downloads a new phone app from the PC on its own; installing it is one tap.

## 1.4.0

- The phone app updates itself over Wi-Fi from the PC: when the PC has a newer version, the phone shows an
  Update card.
- The phone app is signed with Flick's own private key, so only genuine Flick updates install.

## 1.3.0

- Select several items at once; send whole folders.

## 1.2.0

- Four animation themes (Roadster, Liquid, Teleport, Halo), chosen on the PC or the phone.
