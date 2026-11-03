#!/usr/bin/env python3
"""Evict and measure only a fresh test-owned Chrome for Testing directory."""
import ctypes
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


def is_cold(resident, pages):
    return pages > 0 and 0 <= resident <= pages and resident * 100 <= pages


def validate_archive(archive):
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if not entries or sum(item.file_size for item in entries) > 1_500_000_000:
            raise ValueError("invalid archive size")
        for item in entries:
            name = item.filename
            parts = PurePosixPath(name).parts
            mode = item.external_attr >> 16
            if not parts or parts[0] != "chrome-linux64" or ".." in parts or "\\" in name or stat.S_ISLNK(mode):
                raise ValueError("unsafe archive member")


def files_for_eviction(root, runner_temp):
    temp = runner_temp.resolve(strict=True)
    if root.is_symlink() or root.resolve(strict=True) != temp / "apex-cft":
        raise ValueError("unexpected diagnostic directory")
    files = []
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in dirs + names:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError("diagnostic directory contains symlinks")
        for name in names:
            path = Path(directory) / name
            if not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError("diagnostic directory contains non-regular files")
            files.append(path)
    return sorted(files)


def residency(fd, size):
    page_size = os.sysconf("SC_PAGE_SIZE")
    pages = (size + page_size - 1) // page_size
    if not pages:
        return 0, 0
    libc = ctypes.CDLL(None, use_errno=True)
    libc.mmap.restype = ctypes.c_void_p
    libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
    libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_ubyte)]
    libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
    address = libc.mmap(None, size, 1, 1, fd, 0)  # PROT_READ | MAP_SHARED; never touch mapping.
    if address == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_errno(), "mmap failed")
    try:
        vector = (ctypes.c_ubyte * pages)()
        if libc.mincore(address, size, vector) != 0:
            raise OSError(ctypes.get_errno(), "mincore failed")
        return sum(bool(value & 1) for value in vector), pages
    finally:
        if libc.munmap(address, size) != 0:
            raise OSError(ctypes.get_errno(), "munmap failed")


def evict_and_measure(files):
    results = {"files": 0, "resident_pages": 0, "pages": 0, "executable": None}
    for path in files:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("not an exclusively owned regular file")
            os.fsync(fd)  # Writeback belongs solely to this diagnostic fixture.
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            resident, pages = residency(fd, info.st_size)
            results["files"] += 1
            results["resident_pages"] += resident
            results["pages"] += pages
            if path.name == "chrome":
                results["executable"] = {"resident_pages": resident, "pages": pages, "size": info.st_size}
        finally:
            os.close(fd)
    return results


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--check-archive":
        validate_archive(Path(sys.argv[2]))
        print("CFT_ARCHIVE_LAYOUT_VALID", flush=True)
        return
    if sys.platform != "linux" or len(sys.argv) != 1:
        raise RuntimeError("Linux and no arguments required for eviction")
    temp = Path(os.environ["RUNNER_TEMP"])
    files = files_for_eviction(temp / "apex-cft", temp)
    expected = temp / "apex-cft" / "chrome-linux64" / "chrome"
    if expected not in files:
        raise RuntimeError("expected executable missing")
    result = evict_and_measure(files)
    print("CFT_COLD_DIAGNOSTIC " + json.dumps(result), flush=True)
    exe = result["executable"]
    if not exe or not is_cold(exe["resident_pages"], exe["pages"]) or not is_cold(result["resident_pages"], result["pages"]):
        raise RuntimeError("test-owned executable or artifact tree is not cold")


if __name__ == "__main__":
    main()
