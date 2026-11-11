package com.flick.app;

/** Quick Settings tile "Send clipboard": what's copied on this phone goes onto the clipboard of the PC or phone one-tap
 *  sends go to. */
public class TileClip extends FlickTile {
    @Override String what() { return "clip"; }
    @Override String label() { return "Send clipboard"; }
}
