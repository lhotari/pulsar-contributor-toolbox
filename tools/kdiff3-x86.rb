# kdiff3 for arm64 sometime segfaults, this is a way to get x86_64 version installed as a backup
# install with `brew install --cask kdiff3-x86.rb`
cask "kdiff3-x86" do
  # NOTE: "3" is not a version number, but an intrinsic part of the product name
  version "1.11.1"
  sha256 "fdc8e2043cdcf19c926665a4fa7a5534eeba21c48f5eac29542ee135f3887d22"
  url "https://download.kde.org/stable/kdiff3/kdiff3-#{version}-macos-x86_64.dmg"
  name "KDiff3-x86"
  desc "Utility for comparing and merging files and directories"
  homepage "https://invent.kde.org/sdk/kdiff3"

  livecheck do
    url "https://download.kde.org/stable/kdiff3/"
    regex(/href=["']?kdiff3[._-]v?(\d+(?:\.\d+)+)[._-]macos[._-]x86_64\.dmg/i)
  end

  artifact "kdiff3.app", target: "#{appdir}/kdiff3-x86.app"
  shimscript = "#{staged_path}/kdiff3.wrapper.sh"
  binary shimscript, target: "kdiff3-x86"

  preflight do
    File.write shimscript, <<~EOS
      #!/bin/bash
      '#{appdir}/kdiff3-x86.app/Contents/MacOS/kdiff3' "$@"
    EOS
  end

  zap trash: "~/.kdiff3rc"
end
