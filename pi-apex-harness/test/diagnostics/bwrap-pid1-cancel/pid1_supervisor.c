#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/un.h>
#include <unistd.h>

static int
write_all(int fd, const char *data, size_t length)
{
  while (length > 0) {
    ssize_t written = write(fd, data, length);
    if (written < 0) {
      if (errno == EINTR)
        continue;
      return -1;
    }
    data += written;
    length -= (size_t) written;
  }
  return 0;
}

static int
write_flood(int fd, char byte)
{
  char buffer[4096];
  memset(buffer, byte, sizeof buffer);
  for (size_t remaining = 256 * 1024; remaining > 0; ) {
    size_t amount = remaining < sizeof buffer ? remaining : sizeof buffer;
    if (write_all(fd, buffer, amount) < 0)
      return -1;
    remaining -= amount;
  }
  return 0;
}

static int
report_natural_child_exit(void)
{
  (void) write_all(STDERR_FILENO, "NATURAL_CHILD_EXIT\n", 19);
  return 42;
}

int
main(int argc, char **argv)
{
  pid_t descendant;
  int status;

  if (argc != 3 || getpid() != 1 || fcntl(3, F_GETFD) < 0) {
    fprintf(stderr, "SUPERVISOR_PRECONDITION_FAILED\n");
    return 90;
  }

  descendant = fork();
  if (descendant < 0) {
    perror("fork");
    return 91;
  }

  if (descendant == 0) {
    struct sockaddr_un address;
    int identity_socket;
    char acknowledgement;
    const char *script =
      "exec 3>&-; "
      "printf 'DESCENDANT_READY:%s\\n' \"$0\"; "
      "sleep 20 & wait; "
      "printf 'CHILD_NATURAL_COMPLETE:%s\\n' \"$0\"";

    close(3);
    if (setsid() < 0)
      _exit(92);
    identity_socket = socket(AF_UNIX, SOCK_STREAM, 0);
    if (identity_socket < 0)
      _exit(93);
    memset(&address, 0, sizeof address);
    address.sun_family = AF_UNIX;
    if (strlen(argv[2]) >= sizeof address.sun_path)
      _exit(94);
    strcpy(address.sun_path, argv[2]);
    if (connect(identity_socket, (struct sockaddr *) &address, sizeof address) < 0)
      _exit(95);
    if (write_all(identity_socket, "x", 1) < 0 ||
        read(identity_socket, &acknowledgement, 1) != 1 || acknowledgement != '1')
      _exit(96);
    close(identity_socket);
    execl("/bin/sh", argv[1], "-c", script, argv[1], (char *) NULL);
    _exit(97);
  }

  if (write_all(STDOUT_FILENO, "SUPERVISOR_READY\n", 17) < 0 ||
      write_flood(STDOUT_FILENO, 'o') < 0 ||
      write_flood(STDERR_FILENO, 'e') < 0) {
    /* A closed output stream is a test failure, not a reason to signal anyone. */
    return 94;
  }

  for (;;) {
    struct pollfd control = { .fd = 3, .events = POLLIN | POLLHUP };
    pid_t waited = waitpid(descendant, &status, WNOHANG);
    if (waited == descendant)
      return report_natural_child_exit(); /* Never report fallback as cancellation. */
    if (waited < 0 && errno != EINTR) {
      perror("waitpid");
      return 95;
    }

    int ready = poll(&control, 1, 50);
    if (ready < 0) {
      if (errno == EINTR)
        continue;
      perror("poll");
      return 96;
    }
    if (ready > 0 && (control.revents & (POLLIN | POLLHUP | POLLERR))) {
      char byte;
      ssize_t amount = read(3, &byte, sizeof byte);
      if (amount == 0) {
        do {
          waited = waitpid(descendant, &status, WNOHANG);
        } while (waited < 0 && errno == EINTR);
        if (waited == descendant)
          return report_natural_child_exit();
        if (waited < 0) {
          perror("waitpid after control EOF");
          return 98;
        }
        if (write_all(STDOUT_FILENO, "CONTROL_FD_EOF\n", 15) < 0)
          return 99;
        return 0; /* Only the external writer's close should cause this EOF. */
      }
      if (amount < 0 && errno != EINTR) {
        perror("read control fd 3");
        return 97;
      }
    }
  }
}
