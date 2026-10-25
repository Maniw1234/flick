/*
 * Flick media keys (Windows).
 *
 * The phone as a remote: pc/keys.js starts this once and writes one key name per line on its standard input; each is
 * pressed (down, then up) with SendInput, so the player in front, the volume and Windows' media overlay react as if
 * the user had pressed the key on a keyboard. Runs until its input closes (EOF), then exits 0.
 *
 *   play | next | prev | vol-up | vol-down | mute
 *
 * Prints one line per input line: "sent <key>", "unknown <up to 32 bytes>", or "error <key> <GetLastError>".
 * Input is read byte by byte in binary mode: a line too long, a NUL or a Ctrl-Z inside a line is just an unknown line.
 * Build: x86_64-w64-mingw32-gcc -O2 -s -Wall -o flick-keys.exe flick-keys.c -luser32
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <stdio.h>
#include <string.h>

typedef struct { const char *name; WORD vk; } Key;

static const Key KEYS[] = {
    { "play", VK_MEDIA_PLAY_PAUSE },
    { "next", VK_MEDIA_NEXT_TRACK },
    { "prev", VK_MEDIA_PREV_TRACK },
    { "vol-up", VK_VOLUME_UP },
    { "vol-down", VK_VOLUME_DOWN },
    { "mute", VK_VOLUME_MUTE },
};

static int press(WORD vk) {
    INPUT in[2];
    memset(in, 0, sizeof in);
    in[0].type = INPUT_KEYBOARD;
    in[0].ki.wVk = vk;
    in[0].ki.dwFlags = KEYEVENTF_EXTENDEDKEY;
    in[1] = in[0];
    in[1].ki.dwFlags = KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP;
    return SendInput(2, in, sizeof(INPUT)) == 2;
}

static void line_done(char *line, size_t n, int too_long) {
    while (n > 0 && (line[n - 1] == '\r' || line[n - 1] == ' ' || line[n - 1] == '\t')) n--;
    line[n] = 0;
    if (n == 0 && !too_long) return;                      /* empty line: nothing to do */
    const Key *k = NULL;
    if (!too_long && strlen(line) == n) {
        for (size_t i = 0; i < sizeof KEYS / sizeof KEYS[0]; i++) if (strcmp(line, KEYS[i].name) == 0) { k = &KEYS[i]; break; }
    }
    if (!k) {
        /* show it safely: printable ASCII only */
        char shown[33];
        size_t m = 0;
        for (size_t i = 0; i < n && m < 32; i++) shown[m++] = (line[i] >= 0x20 && line[i] < 0x7f) ? line[i] : '?';
        shown[m] = 0;
        printf("unknown %s%s\n", shown, too_long ? "..." : "");
        return;
    }
    if (press(k->vk)) printf("sent %s\n", k->name);
    else printf("error %s %lu\n", k->name, (unsigned long)GetLastError());
}

int main(void) {
    char line[64];
    size_t n = 0;
    int too_long = 0, c;
    _setmode(_fileno(stdin), _O_BINARY);                  /* a Ctrl-Z byte must not read as the end of input */
    setvbuf(stdout, NULL, _IONBF, 0);
    for (;;) {
        c = getchar();
        if (c == EOF || c == '\n') {
            if (n > 0 || too_long) line_done(line, n, too_long);
            n = 0; too_long = 0;
            if (c == EOF) break;
            continue;
        }
        if (n < sizeof line - 1) line[n++] = (char)c; else too_long = 1;
    }
    return 0;
}
