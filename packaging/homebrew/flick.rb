# Flick for Homebrew, from the personal tap Maniw1234/homebrew-flick (where this file goes as Casks/flick.rb):
#   brew install --cask maniw1234/flick/flick
# The version and checksums come from a signed release: node packaging/update.js <version> (packaging/README.md).
# Until a release has Mac disk images, the checksums below are placeholders.
cask "flick" do
  arch arm: "arm64", intel: "x64"

  version "1.0.0"
  sha256 arm:   "0000000000000000000000000000000000000000000000000000000000000000",
         intel: "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/Maniw1234/flick/releases/download/v#{version}/Flick-mac-#{arch}.dmg"
  name "Flick"
  desc "Send files between an Android phone and a computer"
  homepage "https://github.com/Maniw1234/flick"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Flick updates itself (signed releases), like on Windows and Linux
  auto_updates true
  depends_on macos: ">= :ventura"

  app "Flick.app"

  uninstall quit: "com.flick.pc"

  zap trash: [
    "~/Library/Application Support/Flick",
    "~/Library/Caches/com.flick.pc",
    "~/Library/HTTPStorages/com.flick.pc",
    "~/Library/Preferences/com.flick.pc.plist",
    "~/Library/Saved Application State/com.flick.pc.savedState",
  ]

  caveats <<~EOS
    Flick isn't notarized by Apple, so macOS refuses to open it the first time. Open
    System Settings > Privacy & Security and click Open Anyway next to the message about Flick.
  EOS
end
