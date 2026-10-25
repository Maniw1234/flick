package com.flick.app;

/** Quick Settings tile "Send clipboard": what's copied on the phone goes onto the PC's clipboard. */
public class TileClip extends FlickTile {
    @Override String what() { return "clip"; }
    @Override String label() { return "Send clipboard"; }
}
