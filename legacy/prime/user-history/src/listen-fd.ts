/**
 * The listening socket systemd hands over through socket activation (`deploy/linux/sieun-pi-chat.socket`), or null when this process got none.
 * sd_listen_fds(3): the first passed fd is 3, LISTEN_FDS counts them and LISTEN_PID names the process they are for. The variables are removed
 * so a helper this process starts never reads them as its own.
 */
export function takeListenFd(env: NodeJS.ProcessEnv = process.env, pid = process.pid): number | null {
  const count = Number(env.LISTEN_FDS);
  const forPid = Number(env.LISTEN_PID);
  delete env.LISTEN_FDS;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDNAMES;
  return Number.isInteger(count) && count >= 1 && forPid === pid ? 3 : null;
}
