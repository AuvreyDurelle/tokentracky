#!/usr/bin/env python3
"""Build a branded DMG, failing closed on missing/hung Finder automation.

The app must already be signed, notarized and stapled, or only ad-hoc signed when
TOKENTRACKY_SIGNING=adhoc. No signing occurs here.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def run(*args, timeout=120):
    return subprocess.run(args, check=True, timeout=timeout, capture_output=True, text=True).stdout


def build(app, output):
    with tempfile.TemporaryDirectory(prefix="tokentracky-dmg-") as temporary:
        work = Path(temporary)
        stage = work / "stage"
        stage.mkdir()
        run("ditto", str(app), str(stage / "Tokentracky.app"))
        (stage / "Applications").symlink_to("/Applications")
        (stage / ".background").mkdir()
        run("swift", str(Path(__file__).with_name("dmg-background.swift")), str(stage / ".background/background.png"))
        size = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file())
        image = work / "writable.dmg"
        run("hdiutil", "create", "-srcfolder", str(stage), "-volname", "Tokentracky", "-fs", "HFS+", "-format", "UDRW",
            "-size", f"{max(128, size // (1024 * 1024) + 64)}m", str(image))
        mount = work / "mounted"
        mounted = False
        try:
            run("hdiutil", "attach", "-nobrowse", "-mountpoint", str(mount), str(image))
            mounted = True
            # Arguments avoid AppleScript string interpolation of filesystem paths.
            script = '''on run argv
set volumePath to item 1 of argv
with timeout of 30 seconds
  tell application "Finder"
    set diskFolder to (POSIX file volumePath) as alias
    open diskFolder
    set w to container window of diskFolder
    set current view of w to icon view
    set toolbar visible of w to false
    set statusbar visible of w to false
    set bounds of w to {100, 100, 760, 540}
    set opts to icon view options of w
    set arrangement of opts to not arranged
    set icon size of opts to 96
    set text size of opts to 13
    set background picture of opts to file ".background:background.png" of diskFolder
    set position of item "Tokentracky.app" of diskFolder to {180, 240}
    set position of item "Applications" of diskFolder to {480, 240}
    update diskFolder without registering applications
    if (position of item "Tokentracky.app" of diskFolder) is not {180, 240} then error "App layout did not persist"
    if (position of item "Applications" of diskFolder) is not {480, 240} then error "Applications layout did not persist"
    if (icon size of opts) is not 96 then error "Icon size did not persist"
    if (name of (background picture of opts)) is not "background.png" then error "Background did not persist"
    if (bounds of w) is not {100, 100, 760, 540} then error "Window size did not persist"
    close w
  end tell
end timeout
return "styled"
end run'''
            result = run("osascript", "-e", script, str(mount), timeout=40)
            if result.strip() != "styled":
                raise RuntimeError("Finder did not confirm the DMG layout")
            for _ in range(20):
                if (mount / ".DS_Store").is_file():
                    break
                time.sleep(0.25)
            if not (mount / ".DS_Store").is_file():
                raise RuntimeError("Finder failed to persist .DS_Store; enable Finder automation on the release runner")
            if os.environ.get("TOKENTRACKY_SIGNING") != "adhoc":
                run("xcrun", "stapler", "validate", str(mount / "Tokentracky.app"))
            run("codesign", "--verify", "--deep", "--strict", str(mount / "Tokentracky.app"))
        finally:
            if mounted:
                try:
                    run("hdiutil", "detach", str(mount))
                except subprocess.CalledProcessError:
                    run("hdiutil", "detach", "-force", str(mount))
        run("hdiutil", "convert", str(image), "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", str(output))
        run("hdiutil", "verify", str(output))


if __name__ == "__main__":
    os.umask(0o077)
    try:
        build(Path(sys.argv[1]).resolve(strict=True), Path(sys.argv[2]).resolve())
    except (subprocess.SubprocessError, RuntimeError, OSError) as error:
        # Captured stderr is essential for actionable TCC/Finder/attach failures.
        print(f"DMG layout/build failed: {error}\n{getattr(error, 'stderr', '')}", file=sys.stderr)
        sys.exit(1)
