import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two systemd units that schedule `scripts/backup.sh`. Nothing here fails on
 * a development machine, and a unit that names the wrong path fails at 04:17 on
 * a server, into a journal nobody is reading.
 *
 * The units are templates: two lines are meant to be edited per machine. What is
 * asserted is everything that is not.
 */

const root = join(import.meta.dirname, "..");
const service = readFileSync(join(root, "deploy", "cooking-backup.service"), "utf8");
const timer = readFileSync(join(root, "deploy", "cooking-backup.timer"), "utf8");

function setting(unit: string, key: string): string | undefined {
  return unit.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];
}

describe("the backup service", () => {
  it("runs the script this repository actually ships", () => {
    // A rename of the script would otherwise leave the unit pointing at nothing.
    const start = setting(service, "ExecStart");
    expect(start).toBe("/bin/sh scripts/backup.sh");
    expect(() => readFileSync(join(root, "scripts", "backup.sh"))).not.toThrow();
  });

  it("runs the script relative to a working directory, not an absolute path", () => {
    // BACKUP_DIR is relative, so WorkingDirectory is what decides where dumps
    // land. An ExecStart with an absolute path would write them somewhere else.
    expect(setting(service, "WorkingDirectory")).toBeTruthy();
    expect(setting(service, "ExecStart")).not.toMatch(/^\S*\/srv\//);
  });

  it("exits rather than staying resident", () => {
    expect(setting(service, "Type")).toBe("oneshot");
  });

  it("does not run as root", () => {
    const user = setting(service, "User");
    expect(user).toBeTruthy();
    expect(user).not.toBe("root");
  });

  it("waits for the container engine it dumps through", () => {
    // The dump goes through `docker compose exec`, so an early start is a
    // failure rather than a wait.
    expect(service).toContain("After=docker.service");
  });
});

describe("the backup timer", () => {
  it("catches a run missed while the machine was down", () => {
    // The whole reason this is a timer and not a crontab line. Without it, an
    // instance rebooted overnight for a kernel update loses that day's dump and
    // reports nothing.
    expect(setting(timer, "Persistent")).toBe("true");
  });

  it("is scheduled, and installed where timers are started from", () => {
    expect(setting(timer, "OnCalendar")).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(setting(timer, "WantedBy")).toBe("timers.target");
  });
});
