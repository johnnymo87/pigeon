import { spawn } from "node:child_process";
import type { CommandRunner } from "./types";

export const defaultNvimRunner: CommandRunner = {
  async run(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn("nvim", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (buf) => {
        stdout += String(buf);
      });
      proc.stderr.on("data", (buf) => {
        stderr += String(buf);
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  },
};

export const defaultTmuxRunner: CommandRunner = {
  async run(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (buf) => {
        stdout += String(buf);
      });
      proc.stderr.on("data", (buf) => {
        stderr += String(buf);
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  },
};
