# kdiff3 for arm64 sometime segfaults, this is a way to get x86_64 version installed as a backup
# install with `brew install --cask kdiff3-x86.rb`
cask "kdiff3-x86" do
  # NOTE: "3" is not a version number, but an intrinsic part of the product name
  version "1.10.7"
  sha256 "b00d18ecdf1f684c760e905c353d635cb79ce239eeed1fbae0a8bb7970be492a"
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
end
