import { Sinc, TSFIXME } from "@sincronia/types";
import {
  devCommand,
  refreshCommand,
  pushCommand,
  downloadCommand,
  initCommand
} from "./commands";
import yargs from "yargs";
export async function initCommands() {
  yargs
    .command(["dev", "d"], "Start Development Mode", {}, devCommand)
    .command(
      ["refresh", "r"],
      "Refresh Manifest and download new files since last refresh",
      {},
      refreshCommand
    )
    .command(
      ["push [target]"],
      "[DESTRUCTIVE] Push all files from current local files to ServiceNow instance.",
      {},
      (args: TSFIXME) => {
        pushCommand(args as Sinc.PushCmdArgs);
      }
    )
    .command(
      "download <scope>",
      "Downloads a scoped application's files from ServiceNow. Must specify a scope prefix for a scoped app.",
      {},
      (args: TSFIXME) => {
        downloadCommand(args as Sinc.CmdDownloadArgs);
      }
    )
    .command("init", "Provisions an initial project for you", {}, () => {
      initCommand();
    })
    .help().argv;
}
