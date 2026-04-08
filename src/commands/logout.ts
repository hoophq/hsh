import { Command } from "commander";
import { logout } from "../auth/manager.ts";
import { success } from "../ui/output.ts";

export const logoutCommand = new Command("logout")
  .description("Clear local Hoop credentials")
  .action(() => {
    logout();
    success("Logged out successfully.");
  });
