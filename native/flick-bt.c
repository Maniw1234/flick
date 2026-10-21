/*
 * Flick Bluetooth bridge (Windows).
 *
 * Offers Flick's Bluetooth service (an RFCOMM channel registered under Flick's service UUID) and relays every phone
 * that connects to Flick's local port, where pc/bt.js and pc/mux.js take over. Prints one status line per event:
 *   listening <channel> | no-radio | client <address> | gone <address> | error <what>
 *
 * usage: flick-bt.exe <local-port>
 *        flick-bt.exe --tcp <listen-port> <local-port>     (test mode: a TCP listener stands in for RFCOMM)
 *
 * Exit codes: 2 bad arguments, 3 no Bluetooth radio, 4 other failure.
 * Build: x86_64-w64-mingw32-gcc -O2 -s -o flick-bt.exe flick-bt.c -lws2_32
 */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <ws2bth.h>
#include <windows.h>
#include <initguid.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* {7d5b9a64-3c1e-4f0a-9b8e-6c2a1f4e8d10}: the same UUID as BtLink.SERVICE on the phone */
DEFINE_GUID(FLICK_SERVICE, 0x7d5b9a64, 0x3c1e, 0x4f0a, 0x9b, 0x8e, 0x6c, 0x2a, 0x1f, 0x4e, 0x8d, 0x10);

static int g_local_port;
static CRITICAL_SECTION g_out;

static void say(const char *fmt, ...) {
    va_list ap;
    EnterCriticalSection(&g_out);
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
    LeaveCriticalSection(&g_out);
}

typedef struct { SOCKET from, to; volatile LONG *open; } Pipe;

static DWORD WINAPI pump(LPVOID arg) {
    Pipe *p = (Pipe *)arg;
    char buf[64 * 1024];
    for (;;) {
        int n = recv(p->from, buf, sizeof buf, 0);
        if (n <= 0) break;
        int off = 0;
        while (off < n) {
            int w = send(p->to, buf + off, n - off, 0);
            if (w <= 0) { off = -1; break; }
            off += w;
        }
        if (off < 0) break;
    }
    /* one direction ended: end the other side's writing too, so both pumps finish */
    shutdown(p->to, SD_SEND);
    shutdown(p->from, SD_RECEIVE);
    InterlockedDecrement(p->open);
    return 0;
}

typedef struct { SOCKET phone; char who[64]; } Client;

static DWORD WINAPI serve(LPVOID arg) {
    Client *c = (Client *)arg;
    SOCKET local = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)g_local_port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (local == INVALID_SOCKET || connect(local, (struct sockaddr *)&a, sizeof a) != 0) {
        say("error flick-not-reachable %d", WSAGetLastError());
        if (local != INVALID_SOCKET) closesocket(local);
        closesocket(c->phone);
        free(c);
        return 0;
    }
    int one = 1;
    setsockopt(local, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
    volatile LONG open = 2;
    Pipe up = { c->phone, local, &open }, down = { local, c->phone, &open };
    HANDLE t1 = CreateThread(NULL, 0, pump, &up, 0, NULL);
    HANDLE t2 = CreateThread(NULL, 0, pump, &down, 0, NULL);
    if (t1) WaitForSingleObject(t1, INFINITE);
    if (t2) WaitForSingleObject(t2, INFINITE);
    if (t1) CloseHandle(t1);
    if (t2) CloseHandle(t2);
    closesocket(local);
    closesocket(c->phone);
    say("gone %s", c->who);
    free(c);
    return 0;
}

static void accept_loop(SOCKET s, int bluetooth) {
    for (;;) {
        SOCKADDR_STORAGE from;
        int fl = sizeof from;
        SOCKET p = accept(s, (struct sockaddr *)&from, &fl);
        if (p == INVALID_SOCKET) { say("error accept %d", WSAGetLastError()); Sleep(500); continue; }
        Client *c = (Client *)calloc(1, sizeof(Client));
        if (!c) { closesocket(p); continue; }
        c->phone = p;
        if (bluetooth) {
            BTH_ADDR b = ((SOCKADDR_BTH *)&from)->btAddr;
            snprintf(c->who, sizeof c->who, "%02X:%02X:%02X:%02X:%02X:%02X",
                (int)((b >> 40) & 0xff), (int)((b >> 32) & 0xff), (int)((b >> 24) & 0xff),
                (int)((b >> 16) & 0xff), (int)((b >> 8) & 0xff), (int)(b & 0xff));
        } else {
            snprintf(c->who, sizeof c->who, "tcp");
        }
        say("client %s", c->who);
        HANDLE t = CreateThread(NULL, 0, serve, c, 0, NULL);
        if (t) CloseHandle(t); else { closesocket(p); free(c); }
    }
}

static int run_bluetooth(void) {
    SOCKET s = socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM);
    if (s == INVALID_SOCKET) { say("no-radio"); return 3; }
    SOCKADDR_BTH sa;
    memset(&sa, 0, sizeof sa);
    sa.addressFamily = AF_BTH;
    sa.port = BT_PORT_ANY;
    if (bind(s, (struct sockaddr *)&sa, sizeof sa) != 0) {
        int e = WSAGetLastError();
        closesocket(s);
        /* no radio, or Bluetooth turned off */
        if (e == WSAENETDOWN || e == WSAEADDRNOTAVAIL || e == WSAENOTSOCK || e == WSAEAFNOSUPPORT) { say("no-radio"); return 3; }
        say("error bind %d", e);
        return 4;
    }
    int len = sizeof sa;
    if (getsockname(s, (struct sockaddr *)&sa, &len) != 0) { say("error getsockname %d", WSAGetLastError()); return 4; }
    if (listen(s, 4) != 0) { say("error listen %d", WSAGetLastError()); return 4; }

    /* register the service (SDP record) so phones can find the channel by Flick's UUID */
    CSADDR_INFO csa;
    memset(&csa, 0, sizeof csa);
    csa.LocalAddr.iSockaddrLength = sizeof(SOCKADDR_BTH);
    csa.LocalAddr.lpSockaddr = (LPSOCKADDR)&sa;
    csa.iSocketType = SOCK_STREAM;
    csa.iProtocol = BTHPROTO_RFCOMM;
    WSAQUERYSETW qs;
    memset(&qs, 0, sizeof qs);
    qs.dwSize = sizeof qs;
    qs.lpszServiceInstanceName = L"Flick";
    qs.lpszComment = L"Flick: send files between your phone and this PC";
    qs.lpServiceClassId = (LPGUID)&FLICK_SERVICE;
    qs.dwNameSpace = NS_BTH;
    qs.dwNumberOfCsAddrs = 1;
    qs.lpcsaBuffer = &csa;
    if (WSASetServiceW(&qs, RNRSERVICE_REGISTER, 0) != 0) { say("error register %d", WSAGetLastError()); return 4; }

    say("listening %lu", (unsigned long)sa.port);
    accept_loop(s, 1);
    return 0;
}

static int run_tcp(int listen_port) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)listen_port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (s == INVALID_SOCKET || bind(s, (struct sockaddr *)&a, sizeof a) != 0 || listen(s, 4) != 0) { say("error tcp %d", WSAGetLastError()); return 4; }
    say("listening tcp:%d", listen_port);
    accept_loop(s, 0);
    return 0;
}

int main(int argc, char **argv) {
    InitializeCriticalSection(&g_out);
    setvbuf(stdout, NULL, _IONBF, 0);
    WSADATA w;
    if (WSAStartup(MAKEWORD(2, 2), &w) != 0) { say("error wsastartup"); return 4; }
    if (argc == 2) { g_local_port = atoi(argv[1]); if (g_local_port <= 0) return 2; return run_bluetooth(); }
    if (argc == 4 && strcmp(argv[1], "--tcp") == 0) { g_local_port = atoi(argv[3]); return run_tcp(atoi(argv[2])); }
    fprintf(stderr, "usage: flick-bt.exe <local-port> | --tcp <listen-port> <local-port>\n");
    return 2;
}
