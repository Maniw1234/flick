// flick-sparse: marks a file sparse (NTFS) before Flick writes it in several parts at once.
//
// A large file from the phone comes over several connections, each writing its own part of the file at the same time.
// On an ordinary NTFS file, the first write far into the file makes Windows fill everything before it with zeros
// before the write returns: most of the file is written twice and the transfer stalls at its start (seconds for a big
// video on a hard drive). A sparse file has no such gap to fill. When the whole file has arrived it is an ordinary
// file in every way that matters (all of it written).
//
// usage: flick-sparse.exe <file>
// exit: 0 done; 1 it couldn't (not NTFS, say: nothing changed, the file is written as before); 2 no file given
#include <windows.h>
#include <winioctl.h>

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) return 2;
    HANDLE h = CreateFileW(argv[1], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return 1;
    DWORD n = 0;
    BOOL ok = DeviceIoControl(h, FSCTL_SET_SPARSE, NULL, 0, NULL, 0, &n, NULL);
    CloseHandle(h);
    return ok ? 0 : 1;
}
