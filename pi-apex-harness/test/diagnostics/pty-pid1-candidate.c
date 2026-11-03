/* Diagnostic candidate only: PID 1 starts a command after host approval and
 * exits on control EOF, letting the kernel reclaim the PID namespace. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
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
  if (argc < 2 || getpid() != 1) return 90;
  signal(SIGPIPE, SIG_IGN);
  if (write(3, "R", 1) != 1) return 91;
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
    struct pollfd p = { .fd = 3, .events = POLLIN | POLLHUP };
    int ready = poll(&p, 1, 25);
    if (ready < 0 && errno != EINTR) return 96;
    if (ready > 0 && (p.revents & (POLLIN | POLLHUP | POLLERR))) {
      n = read_control(&command);
      if (n == 0) return 0;
      if (n < 0) return 97;
      return 98; /* Unexpected data is not an authorization. */
    }
  }
}
