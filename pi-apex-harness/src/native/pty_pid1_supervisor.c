/* Linux PID-namespace init for the controlled PTY path.
 * Descriptor 3 is an owned, full-duplex host control channel. No command is
 * started until the host sends S after R. EOF means cancellation/parent death.
 * Returning as namespace PID 1 causes the kernel to terminate descendants. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int read_control(char *value) {
  for (;;) {
    ssize_t n = read(3, value, 1);
    if (n >= 0) return (int)n;
    if (errno != EINTR) return -1;
  }
}

int main(int argc, char **argv) {
  if (argc < 2 || getpid() != 1 || fcntl(3, F_GETFD) < 0) return 90;
  /* The payload must not be able to trace or obtain the control descriptor. */
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return 90;
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 91;
  ssize_t sent;
  do { sent = write(3, "R", 1); } while (sent < 0 && errno == EINTR);
  if (sent != 1) return 91;
  char command;
  int n = read_control(&command);
  if (n == 0) return 0;
  if (n != 1 || command != 'S') return 92;
  pid_t child = fork();
  if (child < 0) return 93;
  if (child == 0) {
    close(3);
    signal(SIGPIPE, SIG_DFL);
    execvp(argv[1], argv + 1);
    _exit(127);
  }
  for (;;) {
    int status;
    pid_t reaped = waitpid(-1, &status, WNOHANG);
    if (reaped == child) {
      if (WIFEXITED(status)) return WEXITSTATUS(status);
      if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
      return 94;
    }
    if (reaped < 0 && errno != EINTR) return 95;
    struct pollfd control = { .fd = 3, .events = POLLIN | POLLHUP };
    int ready = poll(&control, 1, 25);
    if (ready < 0 && errno != EINTR) return 96;
    if (ready > 0 && (control.revents & (POLLIN | POLLHUP | POLLERR))) {
      n = read_control(&command);
      if (n == 0) return 0;
      if (n < 0) return 97;
      return 98;
    }
  }
}
