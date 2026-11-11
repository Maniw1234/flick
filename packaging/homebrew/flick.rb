# Flick for Homebrew, from the personal tap Maniw1234/homebrew-flick (where this file goes as Casks/flick.rb):
#   brew install --cask maniw1234/flick/flick
# The version and checksums come from a signed release: node packaging/update.js <version> (packaging/README.md),
# which leaves them as they are for a release without Mac disk images.
cask "flick" do
  arch arm: "arm64", intel: "x64"

  version "2.0.0"
  sha256 arm:   "02383b1f2cf1dccd63470c8c962a1e9747aaefa0d4b1f8ceaeeea6a742cb9327",
         intel: "3727aec806763209acd93861b85fbeecef46b70f4e0ab1b59885391e8ab72e59"

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
