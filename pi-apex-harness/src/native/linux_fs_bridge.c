#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#ifndef __APPLE__
#include <linux/openat2.h>
#include <sys/syscall.h>
#endif
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static const char* ErrnoSymbol(int err, char* fallback, size_t fallback_len) {
  switch (err) {
    case ELOOP: return "ELOOP";
    case EXDEV: return "EXDEV";
    case ENOENT: return "ENOENT";
    case EEXIST: return "EEXIST";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EBADF: return "EBADF";
    case EINVAL: return "EINVAL";
#if EWOULDBLOCK != EAGAIN
    case EWOULDBLOCK: return "EWOULDBLOCK";
#endif
    case EAGAIN: return "EWOULDBLOCK";
    default:
      snprintf(fallback, fallback_len, "ERRNO_%d", err);
      return fallback;
  }
}

static napi_value ThrowSysError(napi_env env, const char* op, int err) {
  char code_buf[32];
  const char* sym = ErrnoSymbol(err, code_buf, sizeof(code_buf));
  char msg[320];
  snprintf(msg, sizeof(msg), "%s: %s (%s)", op, strerror(err), sym);
  napi_throw_error(env, sym, msg);
  return NULL;
}

static int IsValidSingleName(const char* name) {
  if (!name || name[0] == '\0') return 0;
  if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return 0;
  for (const char* p = name; *p != '\0'; ++p) {
    if (*p == '/') return 0;
  }
  return 1;
}

/**
 * openRootDir(absPath: string) -> fd: number
 * Opens a canonical directory with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`.
 */
static napi_value OpenRootDir(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 1) return ThrowSysError(env, "openRootDir(argc)", EINVAL);

  char abs_path[4096];
  size_t path_len = 0;
  napi_get_value_string_utf8(env, args[0], abs_path, sizeof(abs_path), &path_len);
  if (path_len == 0 || path_len >= sizeof(abs_path) - 1 || abs_path[0] != '/') {
    return ThrowSysError(env, "openRootDir(absPath)", EINVAL);
  }

  int fd = open(abs_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return ThrowSysError(env, "open(O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)", errno);

  napi_value out;
  napi_create_int32(env, (int32_t)fd, &out);
  return out;
}

/**
 * openBeneath(dirFd: number, relPath: string, flags: number, mode: number) -> fd: number
 * Uses Linux `openat2(2)` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`
 * and unconditionally sets `O_CLOEXEC`.
 */
static napi_value OpenBeneath(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 4) return ThrowSysError(env, "openBeneath(argc)", EINVAL);

  int32_t dirfd = -1, flags = 0, mode = 0;
  char rel_path[4096];
  size_t path_len = 0;

  napi_get_value_int32(env, args[0], &dirfd);
  napi_get_value_string_utf8(env, args[1], rel_path, sizeof(rel_path), &path_len);
  napi_get_value_int32(env, args[2], &flags);
  napi_get_value_int32(env, args[3], &mode);

  if (path_len == 0 || path_len >= sizeof(rel_path) - 1 || rel_path[0] == '/') {
    return ThrowSysError(env, "openBeneath(relPath)", EXDEV);
  }

#ifdef __APPLE__
  char root_path[4096];
  if (fcntl(dirfd, F_GETPATH, root_path) < 0) {
    return ThrowSysError(env, "fcntl(root, F_GETPATH)", errno);
  }
  size_t root_len = strlen(root_path);

  char path_copy[4096];
  if (path_len >= sizeof(path_copy)) {
    return ThrowSysError(env, "openBeneath(relPath_too_long)", ENAMETOOLONG);
  }
  memcpy(path_copy, rel_path, path_len + 1);

  char* segments[256];
  int num_segments = 0;
  char* token = strtok(path_copy, "/");
  while (token != NULL) {
    if (num_segments >= 256) return ThrowSysError(env, "openBeneath(too_many_segments)", ENAMETOOLONG);
    if (strcmp(token, ".") == 0) {
      // skip
    } else if (strcmp(token, "..") == 0) {
      return ThrowSysError(env, "openBeneath(parent_traversal)", EXDEV);
    } else {
      segments[num_segments++] = token;
    }
    token = strtok(NULL, "/");
  }

  if (num_segments == 0) {
    return ThrowSysError(env, "openBeneath(empty)", EINVAL);
  }

  int cur_fd = dup(dirfd);
  if (cur_fd < 0) return ThrowSysError(env, "dup(dirfd)", errno);
  fcntl(cur_fd, F_SETFD, FD_CLOEXEC);

  for (int i = 0; i < num_segments - 1; i++) {
    struct stat st;
    if (fstatat(cur_fd, segments[i], &st, AT_SYMLINK_NOFOLLOW) < 0) {
      int err = errno;
      close(cur_fd);
      return ThrowSysError(env, "fstatat(intermediate)", err);
    }
    if (S_ISLNK(st.st_mode)) {
      close(cur_fd);
      return ThrowSysError(env, "openBeneath(symlink_intermediate)", ELOOP);
    }
    if (!S_ISDIR(st.st_mode)) {
      close(cur_fd);
      return ThrowSysError(env, "openBeneath(not_a_dir)", ENOTDIR);
    }
    int next_fd = openat(cur_fd, segments[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next_fd < 0) {
      int err = errno;
      close(cur_fd);
      return ThrowSysError(env, "openat(intermediate)", err);
    }
    close(cur_fd);
    cur_fd = next_fd;
  }

  const char* leaf = segments[num_segments - 1];
  struct stat leaf_st;
  if (fstatat(cur_fd, leaf, &leaf_st, AT_SYMLINK_NOFOLLOW) == 0) {
    if (S_ISLNK(leaf_st.st_mode)) {
      close(cur_fd);
      return ThrowSysError(env, "openBeneath(symlink_leaf)", ELOOP);
    }
  } else if (errno != ENOENT) {
    int err = errno;
    close(cur_fd);
    return ThrowSysError(env, "fstatat(leaf)", err);
  }

  int open_flags = flags | O_CLOEXEC | O_NOFOLLOW;
  int target_fd = openat(cur_fd, leaf, open_flags, mode);
  int open_err = errno;
  close(cur_fd);

  if (target_fd < 0) {
    return ThrowSysError(env, "openat(leaf)", open_err);
  }

  char target_path[4096];
  if (fcntl(target_fd, F_GETPATH, target_path) == 0) {
    if (strncmp(target_path, root_path, root_len) != 0 ||
        (target_path[root_len] != '/' && target_path[root_len] != 0)) {
      close(target_fd);
      return ThrowSysError(env, "openBeneath(escaped_root)", EXDEV);
    }
  }

  napi_value out;
  napi_create_int32(env, (int32_t)target_fd, &out);
  return out;
#else
  struct open_how how;
  memset(&how, 0, sizeof(how));
  how.flags = (uint64_t)flags | O_CLOEXEC;
  how.mode = (flags & (O_CREAT | O_TMPFILE)) ? (uint64_t)(mode & 0777) : 0;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS;

  long fd = syscall(SYS_openat2, dirfd, rel_path, &how, sizeof(how));
  if (fd < 0) return ThrowSysError(env, "openat2", errno);

  napi_value out;
  napi_create_int32(env, (int32_t)fd, &out);
  return out;
#endif
}

/**
 * hasCloexec(fd: number) -> boolean
 * Queries kernel `fcntl(fd, F_GETFD)` to verify `FD_CLOEXEC` is active on `fd`.
 */
static napi_value HasCloexec(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 1) return ThrowSysError(env, "hasCloexec(argc)", EINVAL);

  int32_t fd = -1;
  napi_get_value_int32(env, args[0], &fd);
  int fd_flags = fcntl(fd, F_GETFD);
  if (fd_flags < 0) return ThrowSysError(env, "fcntl(F_GETFD)", errno);

  napi_value out;
  napi_get_boolean(env, (fd_flags & FD_CLOEXEC) != 0, &out);
  return out;
}

/**
 * mkdiratSingle(parentDirFd: number, singleName: string, mode: number) -> void
 */
static napi_value MkdiratSingle(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 3) return ThrowSysError(env, "mkdiratSingle(argc)", EINVAL);

  int32_t dirfd = -1, mode = 0755;
  char name[1024];
  size_t len = 0;
  napi_get_value_int32(env, args[0], &dirfd);
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &len);
  napi_get_value_int32(env, args[2], &mode);

  if (!IsValidSingleName(name)) return ThrowSysError(env, "mkdiratSingle(name)", EINVAL);
  if (mkdirat(dirfd, name, (mode_t)(mode & 0777)) < 0) {
    return ThrowSysError(env, "mkdirat", errno);
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/**
 * renameatSingle(oldDirFd: number, oldName: string, newDirFd: number, newName: string) -> void
 */
static napi_value RenameatSingle(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 4) return ThrowSysError(env, "renameatSingle(argc)", EINVAL);

  int32_t old_dfd = -1, new_dfd = -1;
  char old_name[1024], new_name[1024];
  size_t old_len = 0, new_len = 0;
  napi_get_value_int32(env, args[0], &old_dfd);
  napi_get_value_string_utf8(env, args[1], old_name, sizeof(old_name), &old_len);
  napi_get_value_int32(env, args[2], &new_dfd);
  napi_get_value_string_utf8(env, args[3], new_name, sizeof(new_name), &new_len);

  if (!IsValidSingleName(old_name) || !IsValidSingleName(new_name)) {
    return ThrowSysError(env, "renameatSingle(name)", EINVAL);
  }
  if (renameat(old_dfd, old_name, new_dfd, new_name) < 0) {
    return ThrowSysError(env, "renameat", errno);
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/**
 * unlinkatSingle(parentDirFd: number, singleName: string, removeDir: boolean) -> void
 */
static napi_value UnlinkatSingle(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 3) return ThrowSysError(env, "unlinkatSingle(argc)", EINVAL);

  int32_t dirfd = -1;
  char name[1024];
  size_t len = 0;
  bool rmdir_flag = false;
  napi_get_value_int32(env, args[0], &dirfd);
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &len);
  napi_get_value_bool(env, args[2], &rmdir_flag);

  if (!IsValidSingleName(name)) return ThrowSysError(env, "unlinkatSingle(name)", EINVAL);
  if (unlinkat(dirfd, name, rmdir_flag ? AT_REMOVEDIR : 0) < 0) {
    return ThrowSysError(env, "unlinkat", errno);
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

/**
 * fstatatNoFollow(parentDirFd: number, singleName: string) -> { kind, mode, dev, ino, nlink, size } | null
 */
static napi_value FstatatNoFollow(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 2) return ThrowSysError(env, "fstatatNoFollow(argc)", EINVAL);

  int32_t dirfd = -1;
  char name[1024];
  size_t len = 0;
  napi_get_value_int32(env, args[0], &dirfd);
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &len);

  if (!IsValidSingleName(name)) return ThrowSysError(env, "fstatatNoFollow(name)", EINVAL);

  struct stat st;
  if (fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW) < 0) {
    if (errno == ENOENT) {
      napi_value null_val;
      napi_get_null(env, &null_val);
      return null_val;
    }
    return ThrowSysError(env, "fstatat", errno);
  }

  const char* kind = "other";
  if (S_ISREG(st.st_mode)) kind = "file";
  else if (S_ISDIR(st.st_mode)) kind = "dir";
  else if (S_ISLNK(st.st_mode)) kind = "symlink";

  napi_value obj, v_kind, v_mode, v_dev, v_ino, v_nlink, v_size;
  napi_create_object(env, &obj);
  napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &v_kind);
  napi_create_int32(env, (int32_t)(st.st_mode & 0777), &v_mode);
  napi_create_double(env, (double)st.st_dev, &v_dev);
  napi_create_double(env, (double)st.st_ino, &v_ino);
  napi_create_int32(env, (int32_t)st.st_nlink, &v_nlink);
  napi_create_double(env, (double)st.st_size, &v_size);

  napi_set_named_property(env, obj, "kind", v_kind);
  napi_set_named_property(env, obj, "mode", v_mode);
  napi_set_named_property(env, obj, "dev", v_dev);
  napi_set_named_property(env, obj, "ino", v_ino);
  napi_set_named_property(env, obj, "nlink", v_nlink);
  napi_set_named_property(env, obj, "size", v_size);
  return obj;
}

/**
 * readlinkatSingle(parentDirFd: number, singleName: string) -> string
 */
static napi_value ReadlinkatSingle(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 2) return ThrowSysError(env, "readlinkatSingle(argc)", EINVAL);

  int32_t dirfd = -1;
  char name[1024];
  size_t len = 0;
  napi_get_value_int32(env, args[0], &dirfd);
  napi_get_value_string_utf8(env, args[1], name, sizeof(name), &len);

  if (!IsValidSingleName(name)) return ThrowSysError(env, "readlinkatSingle(name)", EINVAL);
  char target[4096];
  ssize_t n = readlinkat(dirfd, name, target, sizeof(target) - 1);
  if (n < 0) return ThrowSysError(env, "readlinkat", errno);
  target[n] = '\0';

  napi_value out;
  napi_create_string_utf8(env, target, (size_t)n, &out);
  return out;
}

/**
 * flockExNb(fd: number) -> void
 * Enforces `FD_CLOEXEC` on `fd` prior to acquiring `flock(fd, LOCK_EX | LOCK_NB)`, ensuring child
 * processes spawned via fork/exec never inherit a reference to the open file description!
 */
static napi_value FlockExNb(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 1) return ThrowSysError(env, "flockExNb(argc)", EINVAL);

  int32_t fd = -1;
  napi_get_value_int32(env, args[0], &fd);

  int fd_flags = fcntl(fd, F_GETFD);
  if (fd_flags < 0) return ThrowSysError(env, "fcntl(F_GETFD)", errno);
  if ((fd_flags & FD_CLOEXEC) == 0) {
    if (fcntl(fd, F_SETFD, fd_flags | FD_CLOEXEC) < 0) {
      return ThrowSysError(env, "fcntl(F_SETFD, FD_CLOEXEC)", errno);
    }
  }

  if (flock(fd, LOCK_EX | LOCK_NB) < 0) {
    return ThrowSysError(env, "flock(LOCK_EX|LOCK_NB)", errno);
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value FlockUn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 1) return ThrowSysError(env, "flockUn(argc)", EINVAL);

  int32_t fd = -1;
  napi_get_value_int32(env, args[0], &fd);
  if (flock(fd, LOCK_UN) < 0) {
    return ThrowSysError(env, "flock(LOCK_UN)", errno);
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value GetFdPath(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc < 1) return ThrowSysError(env, "getFdPath(argc)", EINVAL);
  int32_t fd = -1;
  napi_get_value_int32(env, args[0], &fd);
  char buf[4096];
#ifdef __APPLE__
  if (fcntl(fd, F_GETPATH, buf) < 0) return ThrowSysError(env, "fcntl(F_GETPATH)", errno);
#else
  char proc[64];
  snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
  ssize_t n = readlink(proc, buf, sizeof(buf) - 1);
  if (n < 0) return ThrowSysError(env, "readlink", errno);
  buf[n] = '\0';
#endif
  napi_value out;
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    { "openRootDir", 0, OpenRootDir, 0, 0, 0, napi_default, 0 },
    { "openBeneath", 0, OpenBeneath, 0, 0, 0, napi_default, 0 },
    { "hasCloexec", 0, HasCloexec, 0, 0, 0, napi_default, 0 },
    { "mkdiratSingle", 0, MkdiratSingle, 0, 0, 0, napi_default, 0 },
    { "renameatSingle", 0, RenameatSingle, 0, 0, 0, napi_default, 0 },
    { "unlinkatSingle", 0, UnlinkatSingle, 0, 0, 0, napi_default, 0 },
    { "fstatatNoFollow", 0, FstatatNoFollow, 0, 0, 0, napi_default, 0 },
    { "readlinkatSingle", 0, ReadlinkatSingle, 0, 0, 0, napi_default, 0 },
    { "flockExNb", 0, FlockExNb, 0, 0, 0, napi_default, 0 },
    { "flockUn", 0, FlockUn, 0, 0, 0, napi_default, 0 },
    { "getFdPath", 0, GetFdPath, 0, 0, 0, napi_default, 0 }
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
