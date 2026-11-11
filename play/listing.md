# Google Play: the store listing and the Play Console answers

Everything the Play Console asks for when Flick is set up there, ready to paste. Graphics are in this folder
(`make_graphics.py` makes them again). Package: `io.github.maniw1234.flick` (the same name is in `build_apk.sh`,
`ci/play_upload.js` and `phone/features/about.js`: change all four together).

## Main store listing

**App name** (30 characters at most):

    Flick: Phone to PC Transfer

**Short description** (80 at most):

    Throw files from your phone to your PC with a flick. Fast, private, no cables.

**Full description** (4000 at most):

    Flick sends files between your Android phone and your computer with a flick of your finger. Throw a photo off the edge of the screen, toward your PC, and it lands there, with an animation to match. Send files from the PC back to the phone the same way.

    Flick needs its free companion app on your computer, for Windows, Mac or Linux: github.com/Maniw1234/flick/releases/latest

    WHAT YOU CAN DO
    • Send photos, videos and any file from phone to PC and back, with a flick
    • Send files from phone to phone, and from PC to PC
    • Share the clipboard and links between your devices
    • See your phone's notifications on your PC
    • Keep folders in sync between phone and PC
    • Use the phone as a media remote for your PC
    • Air grab: close your hand over a file and drop it on your PC
    • Auto-send new screenshots or camera photos to your PC
    • Browse your phone's files from the PC
    • Find my phone: ring it from your PC

    FAST
    Files go straight from one device to the other over your Wi-Fi, a USB cable, your phone's hotspot or Bluetooth. Large files use several connections at once, and a send that's cut off carries on where it stopped.

    PRIVATE
    No account, no ads, no analytics, no cloud. Everything travels encrypted between your own devices and never goes through the internet. Devices pair once, with a code you check on both screens.

    A FILE MANAGER TOO
    Flick shows every file on your phone, sorted into Photos, Videos, Downloads, Documents, Audio and APKs, with search and previews, so you can find what to send.

    Flick is free and open source.

**App category:** Tools. **Tags:** File transfer, File manager, Productivity.

**Contact email:** the Play developer account's email. **Website:** https://github.com/Maniw1234/flick

**Privacy policy URL:** https://github.com/Maniw1234/flick/blob/main/PRIVACY.md (it's there once this branch is
released to the public repo; until then that link doesn't work).

## Graphics (this folder)

| Play asks for | File |
| --- | --- |
| App icon, 512 × 512 | `icon-512.png` |
| Feature graphic, 1024 × 500 | `feature-graphic.png` |
| Phone screenshots, 2 to 8 | `screenshots/*.png` (1080 × 2160) |

The screenshots are from the test emulator: retake them on a real phone with real photos before the listing goes
public (`make_graphics.py` frames any 1080 × 2400 screenshot put in `play/raw/`).

## App content (Policy › App content)

- **Ads:** No ads.
- **App access:** All functionality is available without special access (no login). Note for reviewers: "Flick
  works with its free computer app (github.com/Maniw1234/flick/releases/latest). Without it, the file browser,
  phone-to-phone sending and all settings can still be used."
- **Content rating:** questionnaire category "Utility, Productivity, Communication or Other": answer No to everything.
  The answer to "Does the app let users share content or communicate with others" is No: it only moves files between
  the user's own devices.
- **Target audience:** 18 and over (not designed for children).
- **News app:** No. **Government app:** No. **Financial features:** None. **Health:** None.

### Data safety

- Does the app collect or share user data? **Yes** (only Send feedback, which the user starts).
- Is all data encrypted in transit? **Yes**. Can users ask for data to be deleted? **Yes** (through Send feedback or a
  GitHub issue).
- Collected, **optional**, not shared, used for **App functionality / Developer communications** (answering
  feedback):
  - Personal info › **Email address** (only if typed in Send feedback)
  - App info and performance › **Crash logs** and **Diagnostics** (the device details and last crash report, only if
    left ticked in Send feedback)
  - Messages › **Other in-app messages** (the feedback message)
- Not collected: everything else. Files, the clipboard, links and notifications go only between the user's own
  devices over the local network, and never reach the developer (Google's definition of "collected" is data sent
  off the device to the developer or a third party).

### Permission declarations

- **All files access (MANAGE_EXTERNAL_STORAGE):** core use "File management" / "Device to device file transfer".
  Text: "Flick sends any file on the phone to the user's own computer or other phone, and shows all files sorted by
  type as a file manager does. The user picks files from anywhere on the phone, including folders the media APIs don't
  cover (Downloads, Documents, APKs, app folders), so scoped storage and the system file picker can't do it."
- **Foreground service types:** `dataSync` (sending and receiving files the user started, which carry on with the
  screen off) and `connectedDevice` (staying connected to the user's paired computer when "Stay connected in the
  background" is on). Play asks for a short video of each: record starting a large send and turning the screen off,
  and turning on Stay connected in the background.
- **Notification access:** no Play form, but the app shows what it reads and where it goes before Android's screen
  opens (Settings › Show notifications on your PC).
- **Camera:** Air grab only; frames are analysed on the phone and never saved or sent.
- **Location:** used only because Android requires it for Wi-Fi and Bluetooth scanning on older versions; not used in
  the background, so no location declaration is needed.

## The first release (by hand), and the ones after it

Google's API can't make an app or its first release, so the first bundle goes up by hand:

1. Leave the `PLAY_SERVICE_ACCOUNT` secret unset for that release. The release workflow still builds the bundle
   (when the phone app changed, or in a run with "Only build and check" ticked) and keeps it with the run for five
   days: Actions > Release > the run > Artifacts > `play-bundle` (`Flick-play.aab`). Its "play" job only says that it
   wasn't uploaded. To build it by hand instead: `FLICK_VARIANT=play ./build_apk.sh <versionCode> <versionName>`
   (README, "Building by hand").
2. In the Play Console, create the app (`io.github.maniw1234.flick`), fill in this page's answers, and upload
   `Flick-play.aab` to a track. Play App Signing is on for a new app: Google signs what it hands out, and the key that
   signed the bundle (Flick's) becomes the upload key.
3. Then set the secret (the JSON key of a service account that Play Console > Users and permissions lets release
   Flick). From the next release that changes the phone app, the workflow uploads the bundle itself: as a **draft** on
   the production track unless the variables `PLAY_STATUS` (`draft` or `completed`) and `PLAY_TRACK` say otherwise. A
   draft waits in the Play Console for "Start rollout", so nothing reaches Google's review before you have looked at
   it (the workflow uploads before the release is signed with `signing/sign_release.js`).

A version Google Play has already (the one uploaded by hand, or a release run again) isn't uploaded twice: the job
says so in a notice and ends well. After the five days the bundle is gone from the run: a run with "Only build and
check" ticked builds the same one again.

## The day the listing is public

- `pc/panel/panel.js`: set `PLAY_LIVE` to `true`. The PC's welcome card then sends the phone to Google Play first
  (the .apk on GitHub stays as the other way). Change step 2 of the README's "Install" the same way.
- The Google Play version's Settings › Help › Rate Flick opens the listing (`phone/features/about.js`); it shows
  nothing useful until the listing is public.
- The Google Play version and the GitHub .apk are two apps to Android (two package names): a phone can have both.
  Tell people who had the .apk to remove it after installing from Google Play, and pair again.
