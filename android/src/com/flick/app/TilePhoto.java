package com.flick.app;

/** Quick Settings tile "Send last photo": the newest photo or screenshot to the paired PC. */
public class TilePhoto extends FlickTile {
    @Override String what() { return "photo"; }
    @Override String label() { return "Send last photo"; }
}
